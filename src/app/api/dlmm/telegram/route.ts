import { NextRequest, NextResponse } from 'next/server';
import {
  deployPosition,
  editPosition,
  removePosition,
  setAgentEnabled,
  setDryRun,
  updateThreshold,
} from '@/utils/dlmm/actions';
import { getAgentConfig, getPositions } from '@/utils/dlmm/db';
import {
  answerTelegramCallback,
  isTelegramAdmin,
  sendTelegramAlert,
} from '@/utils/telegram';

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number } };
  };
}

function validateWebhook(req: NextRequest): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
  return req.headers.get('X-Telegram-Bot-Api-Secret-Token') === secret;
}

async function handleCommand(chatId: number, text: string): Promise<string> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase().split('@')[0];

  switch (cmd) {
    case '/status': {
      const config = await getAgentConfig();
      const positions = await getPositions('open');
      return [
        '🤖 DLMM Agent Status',
        `Enabled: ${config.enabled ? '✅' : '⏸'}`,
        `Dry run: ${config.dry_run ? '🧪 ON' : '🔴 LIVE'}`,
        `Open positions: ${positions.length}`,
        `At-risk cap: ${config.max_sol_at_risk} SOL`,
      ].join('\n');
    }
    case '/pause':
      await setAgentEnabled(false);
      return '⏸ Agent paused.';
    case '/resume':
      await setAgentEnabled(true);
      return '▶️ Agent resumed.';
    case '/dryrun': {
      const mode = parts[1]?.toLowerCase();
      if (mode === 'on') {
        await setDryRun(true);
        return '🧪 Dry-run enabled.';
      }
      if (mode === 'off') {
        await setDryRun(false);
        return '🔴 LIVE mode enabled. On-chain txs will execute.';
      }
      return 'Usage: /dryrun on|off';
    }
    case '/positions': {
      const positions = await getPositions();
      const open = positions.filter((p) => p.status !== 'closed').slice(0, 10);
      if (open.length === 0) return 'No active positions.';
      return open
        .map(
          (p, i) =>
            `${i + 1}. ${p.pool_name} | ${p.status} | PnL ${p.pnl_pct.toFixed(2)}% | id ${p.id.slice(0, 8)}`,
        )
        .join('\n');
    }
    case '/deploy': {
      const pool = parts[1];
      const amount = parseFloat(parts[2] ?? '');
      if (!pool || !Number.isFinite(amount)) return 'Usage: /deploy <poolAddress> <amountSol>';
      const result = await deployPosition({ poolAddress: pool, amountSol: amount });
      return result.message;
    }
    case '/close': {
      const id = parts[1];
      if (!id) return 'Usage: /close <positionId>';
      const result = await removePosition(id);
      return result.message;
    }
    case '/edit': {
      const id = parts[1];
      const field = parts[2];
      const value = parseFloat(parts[3] ?? '');
      if (!id || !field || !Number.isFinite(value)) {
        return 'Usage: /edit <id> <takeProfitPct|stopLossPct|oorTimeoutMin> <value>';
      }
      const patch: Record<string, number> = {};
      if (field === 'takeProfitPct') patch.takeProfitPct = value;
      else if (field === 'stopLossPct') patch.stopLossPct = value;
      else if (field === 'oorTimeoutMin') patch.oorTimeoutMin = value;
      else return 'Unknown field';
      const result = await editPosition(id, patch);
      return result.message;
    }
    case '/set': {
      const key = parts[1];
      const value = parseFloat(parts[2] ?? '');
      const allowed = [
        'min_tvl',
        'min_fee_tvl',
        'min_organic_score',
        'min_holders',
        'take_profit_pct',
        'stop_loss_pct',
        'oor_timeout_min',
      ] as const;
      if (!key || !Number.isFinite(value) || !allowed.includes(key as typeof allowed[number])) {
        return `Usage: /set <${allowed.join('|')}> <value>`;
      }
      await updateThreshold(key as typeof allowed[number], value);
      return `✅ Set ${key} = ${value}`;
    }
    case '/help':
    default:
      return [
        'DLMM Bot Commands:',
        '/status /pause /resume /dryrun on|off',
        '/positions /deploy <pool> <sol>',
        '/close <id> /edit <id> <field> <value>',
        '/set <threshold> <value>',
      ].join('\n');
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!validateWebhook(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const update = (await req.json()) as TelegramUpdate;

    if (update.callback_query) {
      const chatId = update.callback_query.message?.chat.id ?? update.callback_query.from.id;
      if (!isTelegramAdmin(chatId)) {
        await answerTelegramCallback(update.callback_query.id, 'Unauthorized');
        return NextResponse.json({ ok: true });
      }

      const data = update.callback_query.data ?? '';
      const [action, positionId] = data.split(':');
      let reply = 'Done';

      if (action === 'close' && positionId) {
        const result = await removePosition(positionId);
        reply = result.message;
      } else if (action === 'mute' && positionId) {
        const result = await editPosition(positionId, { muted: true });
        reply = result.message;
      }

      await answerTelegramCallback(update.callback_query.id, reply);
      await sendTelegramAlert(reply, { chatId: String(chatId) });
      return NextResponse.json({ ok: true });
    }

    const message = update.message;
    if (!message?.text) {
      return NextResponse.json({ ok: true });
    }

    const chatId = message.chat.id;
    if (!isTelegramAdmin(chatId)) {
      await sendTelegramAlert('Unauthorized', { chatId: String(chatId) });
      return NextResponse.json({ ok: true });
    }

    const reply = await handleCommand(chatId, message.text);
    await sendTelegramAlert(reply, { chatId: String(chatId) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DLMM Telegram]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed' },
      { status: 500 },
    );
  }
}
