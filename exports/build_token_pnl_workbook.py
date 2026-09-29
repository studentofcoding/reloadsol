"""Assemble the token-PnL CSV export into a multi-sheet workbook.

Mirrors exports/build_workbook.py (same layout conventions, same self-check). The CSV carries a
`#` metadata block, one header row and three row sections (`winner` / `loser` / `all`); this splits
them into sheets so the top 10 winners, the top 10 losers and the full list are each readable on
their own tab.

Usage:
    python3 exports/build_token_pnl_workbook.py [path/to/token_pnl_*.csv]
"""
import csv
import glob
import os
import re
import sys
from datetime import datetime
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_DIR = os.path.join(BASE, 'csv')
HEADER_FILL = PatternFill('solid', fgColor='1F4E78')


def newest_token_pnl_csv():
    candidates = sorted(glob.glob(os.path.join(CSV_DIR, 'token-pnl_*.csv')))
    if not candidates:
        sys.exit(f'no token-pnl_*.csv in {CSV_DIR} — run the export first')
    return candidates[-1]


def parse_export(path):
    meta, header, rows = [], [], {'winner': [], 'loser': [], 'all': []}
    with open(path, newline='', encoding='utf-8') as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith('#'):
                if stripped == '#':
                    continue
                key, _, value = stripped[1:].partition(',')
                meta.append((key.strip(), value.strip()))
                continue
            cells = next(csv.reader([line]))
            if not cells:
                continue
            if cells[0] == 'section':
                header = cells
            elif cells[0] in rows:
                rows[cells[0]].append(cells)
    if not header:
        sys.exit(f'{path}: no header row found')
    return meta, header, rows


def convert(column, value):
    if value == '':
        return None
    lowered = column.lower()
    if lowered in {'rank'} or lowered.endswith('_pct') or lowered.endswith('_sol') or lowered.endswith('_count') or lowered in {'trades', 'won', 'lost'}:
        try:
            return int(value) if re.fullmatch(r'-?\d+', value) else float(value)
        except ValueError:
            return value
    return value


def add_sheet(book, title, header, rows):
    sheet = book.create_sheet(title)
    sheet.append(header)
    for cell in sheet[1]:
        cell.font = Font(bold=True, color='FFFFFF')
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal='center', vertical='center')
    for row in rows:
        sheet.append([convert(header[i], v) for i, v in enumerate(row)])
    sheet.freeze_panes = 'A2'
    if sheet.max_row >= 1 and sheet.max_column >= 1:
        sheet.auto_filter.ref = sheet.dimensions
    sheet.row_dimensions[1].height = 28
    for index, name in enumerate(header, 1):
        width = min(max(10, len(str(name)) + 2), 38)
        for row_index in range(2, min(sheet.max_row, 201) + 1):
            value = sheet.cell(row_index, index).value
            if value is not None:
                width = min(max(width, len(str(value)) + 2), 38)
        sheet.column_dimensions[get_column_letter(index)].width = width
    return sheet.max_row - 1


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else newest_token_pnl_csv()
    meta, header, rows = parse_export(path)
    meta_map = dict(meta)
    stamp = datetime.now()
    label = f"{meta_map.get('range', 'export').replace('..', '_to_')}"
    outfile = os.path.join(BASE, f'token-pnl-{label}-{stamp:%Y%m%d-%H%M}.xlsx')

    book = Workbook()
    readme = book.active
    readme.title = 'README'
    readme['A1'] = 'Token PnL export — paper (simulated) strategy outcomes'
    readme['A1'].font = Font(bold=True, size=14)
    lines = [
        ('Source CSV', os.path.basename(path)),
        ('Range (inclusive)', meta_map.get('range', '')),
        ('Timezone', meta_map.get('timezone', '')),
        ('Position size (native unit per position)', meta_map.get('position_size_sol', '')),
        ('Chains', meta_map.get('chains', '')),
        ('Generated at', meta_map.get('generated_at', '')),
        ('', ''),
        ('Sheets', 'summary = window totals; winners/losers = top 10 tokens by PnL; all_tokens = every token in the range'),
        ('', ''),
        ('Read this before acting on the numbers', ''),
    ]
    for i, (key, value) in enumerate(lines, start=3):
        readme[f'A{i}'] = key
        readme[f'B{i}'] = value
    caveats = [
        'Every row is is_simulated = true. There are no real fills, so there is no slippage, '
        'liquidity or fee model behind these percentages.',
        'sum(pnl_pct) is a sum of per-trade percentages, NOT a portfolio return. The notional '
        'column (position_size x pnl_pct/100) is the meaningful one and is only valid because '
        'every position is assumed to be independently the same size.',
        'The result is right-tail driven: check top{n}_share_of_wins_pct in the summary sheet and '
        'the median, which is usually 0. Removing the best few tokens changes the total a lot.',
        'When the range spans chains, the notional column mixes native units (sol = SOL, '
        'robinhood = ETH). Percentages stay comparable; the notional column does not.',
        'peak_concurrent x position_size is the capital that was actually needed at once — not '
        'the trade count x size, because capital recycles.',
    ]
    start = 3 + len(lines)
    for i, text in enumerate(caveats, start=start):
        readme[f'A{i}'] = text
        readme.merge_cells(f'A{i}:H{i}')
        readme[f'A{i}'].alignment = Alignment(wrap_text=True, vertical='top')
    readme.column_dimensions['A'].width = 42
    readme.column_dimensions['B'].width = 96

    counts = {}
    counts['summary'] = add_sheet(book, 'summary', ['metric', 'value'], list(meta))
    counts['winners'] = add_sheet(book, 'winners_top10', header, rows['winner'])
    counts['losers'] = add_sheet(book, 'losers_top10', header, rows['loser'])
    counts['all_tokens'] = add_sheet(book, 'all_tokens', header, rows['all'])

    book.active = 0
    book.properties.creator = 'Architype'
    book.properties.title = 'Token PnL export (simulated)'
    book.save(outfile)

    check = load_workbook(outfile, read_only=True, data_only=True)
    assert check.sheetnames == ['README', 'summary', 'winners_top10', 'losers_top10', 'all_tokens'], check.sheetnames
    check.close()
    print(outfile)
    for key, value in counts.items():
        print(f'{key}\t{value}')
    print(f'size_bytes\t{os.path.getsize(outfile)}')


if __name__ == '__main__':
    main()
