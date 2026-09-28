import csv, os, re
from datetime import datetime
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_DIR = os.path.join(BASE, 'csv')
now = datetime.now()
outfile = os.path.join(BASE, f'social-tokens-export-{now:%Y%m%d-%H%M}-WIB.xlsx')

files = [
    ('social_rollups', 'social_rollups.csv'),
    ('pattern_24h', 'pattern_24h.csv'),
    ('pattern_winners', 'pattern_winners.csv'),
    ('pattern_losers', 'pattern_losers.csv'),
    ('source_mix', 'source_mix.csv'),
    ('social_enriched', 'social_enriched.csv'),
    ('rugs_concentration', 'rugs_concentration.csv'),
    ('rugs_all', 'rugs_all.csv'),
    ('detect_concentration', 'detect_concentration.csv'),
    ('mention_top', 'mention_top.csv'),
]

wb = Workbook()
ws = wb.active
ws.title = 'README'
ws['A1'] = 'Architype buy_bulk/reloadsol social + saved token data export'
ws['A1'].font = Font(bold=True, size=14)
ws['A3'] = 'Export timestamp (WIB)'
ws['B3'] = now.strftime('%Y-%m-%d %H:%M WIB')
ws['A5'] = 'Sheet'
ws['B5'] = 'Contents'
for c in ('A5','B5'):
    ws[c].font = Font(bold=True, color='FFFFFF')
    ws[c].fill = PatternFill('solid', fgColor='1F4E78')
ws['A6'] = 'social_rollups'; ws['B6'] = 'All columns from social_token_rollups.'
ws['A7'] = 'pattern_24h'; ws['B7'] = 'All mcap_social_pattern_24h rows; snapshot is truncated to 32,000 chars and common mcapTracker scalars are extracted.'
ws['A8'] = 'pattern_winners / pattern_losers'; ws['B8'] = 'Pattern cohorts split from pattern_24h; winners sorted by growth descending.'
ws['A9'] = 'source_mix'; ws['B9'] = 'Rollup first_source counts plus 7-day social event_type/source counts.'
ws['A10'] = 'social_enriched'; ws['B10'] = 'One row per social rollup with pattern, mcap tracking, aggregated rugs, and earliest concentration detect features.'
ws['A11'] = 'rugs_concentration / rugs_all'; ws['B11'] = 'Concentration-only rugs and the full token_rug_list.'
ws['A12'] = 'detect_concentration'; ws['B12'] = 'Concentration token_detect_snapshots with known feature keys; bars JSON is intentionally omitted.'
ws['A13'] = 'mention_top'; ws['B13'] = 'Top 100 rollups by mention_count_24h with pattern/mcap/rug joins.'
ws['A15'] = 'Concentration / Token Info coverage'
ws['A15'].font = Font(bold=True, color='9C0006')
ws['A16'] = ('ledger_* columns come from token_info_detect — the GMGN Freeview nine-tile panel frozen once '
             'per (chain, token_address) at first strategy detect. It is write-once, so it only covers tokens '
             'detected since the ledger went live, and null tiles are never backfilled. Insiders/Snipers hold % '
             'are frequently NULL because the GMGN web payload carries only insider/sniper WALLET COUNTS '
             '(ledger_sniper_wallet_count), not hold rates. token_mcap_tracking.top_holders_pct (Jupiter-sourced, '
             '~32% filled) and OHLC concentration snapshots (dumpPct/wick in detect_*) are the other, independent '
             'sources — keep all three rather than treating them as duplicates.')
ws.merge_cells('A16:H16')
ws['A16'].alignment = Alignment(wrap_text=True, vertical='top')
ws.column_dimensions['A'].width = 28
ws.column_dimensions['B'].width = 110
for r in range(6,14):
    ws[f'B{r}'].alignment = Alignment(wrap_text=True, vertical='top')
ws.row_dimensions[16].height = 45

numeric_exact = {
    'mention_count_5m','mention_count_30m','mention_count_24h','unique_channel_count_30m',
    'smart_wallet_buy_count_1h','smart_wallet_buy_sol_1h','fomo_buy_count_1h','fomo_edge_1h',
    'mcap_growth_percent','first_mcap','current_mcap','peak_mcap','peak_growth_percent',
    'organic_score','top_holders_pct','volume_5m','pattern_mcap_growth_percent',
    'mcap_first_mcap','mcap_current_mcap','mcap_peak_mcap','mcap_growth_percent',
    'mcap_peak_growth_percent','mcap_top_holders_pct','mcap_organic_score','mcap_volume_5m',
    'snapshot_first_mcap','snapshot_current_mcap','snapshot_peak_mcap','snapshot_mcap_growth_percent',
    'snapshot_peak_growth_percent','snapshot_top_holders_pct','snapshot_organic_score','snapshot_volume_5m',
    'dumpPct','avgUpperWick','volDeathRatio','upOnlyCount','n','wickTripBars',
    'detect_dumpPct','detect_avgUpperWick','detect_volDeathRatio','detect_upOnlyCount','detect_n','detect_wickTripBars',
    'count','concentration_banned'
}
# Header suffixes for aliases and table fields not listed literally above.
def convert(header, value):
    if value == '':
        return None
    hl = header.lower()
    if header in numeric_exact or hl.endswith('_count') or hl.endswith('_pct') or hl.endswith('_percent') or hl.endswith('_mcap') or hl.endswith('_score') or hl in {'count'}:
        try:
            if re.fullmatch(r'-?\d+', value): return int(value)
            return float(value)
        except ValueError:
            return value
    if header in {'is_rugged','concentration_banned','is_tracking_stuck',
                  'ledger_freeze_auth','ledger_mint_auth'}:
        if value.lower() == 'true': return True
        if value.lower() == 'false': return False
    return value

def add_csv_sheet(title, path):
    ws = wb.create_sheet(title)
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.reader(f)
        try:
            headers = next(reader)
        except StopIteration:
            headers = []
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True, color='FFFFFF')
            cell.fill = PatternFill('solid', fgColor='1F4E78')
            cell.alignment = Alignment(horizontal='center', vertical='center')
        for row in reader:
            ws.append([convert(headers[i], v) for i, v in enumerate(row)])
    ws.freeze_panes = 'A2'
    if ws.max_row >= 1 and ws.max_column >= 1:
        ws.auto_filter.ref = ws.dimensions
    ws.row_dimensions[1].height = 30
    for col_idx, header in enumerate(headers, 1):
        max_len = min(max(10, len(str(header)) + 2), 36)
        # Inspect up to 200 data cells for a useful width without making huge JSON columns enormous.
        for row_idx in range(2, min(ws.max_row, 201) + 1):
            v = ws.cell(row_idx, col_idx).value
            if v is not None:
                max_len = min(max(max_len, len(str(v)) + 2), 36)
        if 'snapshot' in str(header).lower() or 'raw_' in str(header).lower():
            max_len = 36
        ws.column_dimensions[get_column_letter(col_idx)].width = max_len
    return ws.max_row - 1, ws.max_column

counts = {}
for title, filename in files:
    counts[title] = add_csv_sheet(title, os.path.join(CSV_DIR, filename))[0]

# Keep the README at the front and set workbook calculation metadata.
wb.active = 0
wb.properties.creator = 'Architype'
wb.properties.title = 'Architype social and saved token data export'
wb.save(outfile)

# Validate that the workbook opens and report counts.
check = load_workbook(outfile, read_only=True, data_only=True)
assert check.sheetnames == ['README'] + [x[0] for x in files]
check.close()
print(outfile)
for k,v in counts.items():
    print(f'{k}\t{v}')
print(f'size_bytes\t{os.path.getsize(outfile)}')
