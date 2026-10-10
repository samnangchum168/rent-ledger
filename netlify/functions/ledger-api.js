import { getStore } from '@netlify/blobs';
import nodemailer from 'nodemailer';

// ---------------------------------------------------------------------------
// Ledger API: one endpoint the app talks to.
//   action "sync"      -> app pushes its properties/payments so reminders can check them
//   action "reminders"     -> preview (dry_run) or send today's reminder emails right now
//   action "texts-preview" -> show the text messages due today (changes nothing)
//   action "texts"         -> return today's text messages for the iPhone Shortcut to send,
//                             and mark them as handed over so they are never sent twice
// The daily schedule (ledger-cron.mjs) calls runReminders() directly.
// ---------------------------------------------------------------------------

const TZ = 'Australia/Melbourne';

// Days relative to the due date. -3 = three days before, 0 = due date, 1 and 3 = days after.
const STAGES = [
  { stage: 'before', days: -3 },
  { stage: 'due', days: 0 },
  { stage: 'late1', days: 1 },
  { stage: 'late3', days: 3 },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const str = (v, max = 400) => String(v ?? '').slice(0, max);

// ----- date helpers (dates are plain 'YYYY-MM-DD' strings) -------------------

export function melbourneToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const toMs = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => fromMs(toMs(d) + n * 86400000);

// Due date for a given year/month (month may overflow, e.g. 0 or 13). Clamps day 31 to month end.
export function dueDateFor(year, month, dueDay) {
  const y = year + Math.floor((month - 1) / 12);
  const m = (((month - 1) % 12) + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(dueDay, lastDay);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function candidateDueDates(today, dueDay) {
  const [y, m] = today.split('-').map(Number);
  return [dueDateFor(y, m - 1, dueDay), dueDateFor(y, m, dueDay), dueDateFor(y, m + 1, dueDay)];
}

const fmtDate = (d) =>
  new Date(toMs(d)).toLocaleDateString('en-AU', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

const money = (n) =>
  Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ----- paid detection --------------------------------------------------------
// A due date counts as paid when a recorded payment's "period covered" includes it.
// Older records with no period fall back to "received within 10 days of the due date".
export function isPaid(payments, propertyId, dueDate) {
  return payments.some((p) => {
    if (p.propertyId !== propertyId) return false;
    if (p.periodStart && p.periodEnd) return p.periodStart <= dueDate && dueDate <= p.periodEnd;
    if (p.date) return p.date >= addDays(dueDate, -10) && p.date <= addDays(dueDate, 10);
    return false;
  });
}

// ----- planning --------------------------------------------------------------
export function planReminders(snapshot, today) {
  const payments = snapshot.payments || [];
  const items = [];
  const upcoming = [];

  for (const property of snapshot.properties || []) {
    const dueDay = Number(property.dueDay);
    if (!dueDay || dueDay < 1 || dueDay > 31 || !property.email) continue;

    const dues = candidateDueDates(today, dueDay);

    for (const dueDate of dues) {
      for (const { stage, days } of STAGES) {
        if (addDays(dueDate, days) === today) {
          items.push({ property, dueDate, stage, paid: isPaid(payments, property.id, dueDate) });
        }
      }
    }

    // Summary of the cycle currently in play (still within its last reminder window).
    const lastStageDays = STAGES[STAGES.length - 1].days;
    const current = dues.find((d) => addDays(d, lastStageDays) >= today);
    if (current) {
      upcoming.push({
        property: property.name,
        tenant: property.tenant,
        dueDate: current,
        paid: isPaid(payments, property.id, current),
        reminderDates: STAGES.map((s) => addDays(current, s.days)),
      });
    }
  }
  return { items, upcoming };
}

// ----- email text ------------------------------------------------------------
function buildEmail(snapshot, item) {
  const { property, dueDate, stage } = item;
  const settings = snapshot.settings || {};
  const fromName = property.ownerName || settings.landlordName || 'Your landlord';
  const replyTo = property.ownerEmail || settings.landlordEmail || undefined;
  const amountText = property.rent ? ` of ${money(property.rent)}` : '';
  // Each property can have its own payment details; otherwise fall back to the default in Settings.
  const details = (property.paymentDetails || settings.bankDetails || '').trim();
  const bank = details ? `\n\nPayment details:\n${details}` : '';
  const ignore = `If you have already paid, please ignore this message and thank you.`;

  let subject;
  let intro;
  if (stage === 'before') {
    subject = `Rent reminder: ${property.name}, due ${fmtDate(dueDate)}`;
    intro = `This is a friendly reminder that your rent${amountText} for ${property.name} is due on ${fmtDate(dueDate)}.`;
  } else if (stage === 'due') {
    subject = `Rent due today: ${property.name}`;
    intro = `Your rent${amountText} for ${property.name} is due today (${fmtDate(dueDate)}).`;
  } else if (stage === 'late1') {
    subject = `Rent not yet received: ${property.name}, was due ${fmtDate(dueDate)}`;
    intro = `Our records show that your rent${amountText} for ${property.name}, which was due yesterday (${fmtDate(dueDate)}), has not yet been received. If it is on its way, thank you. Otherwise, please arrange payment today.`;
  } else {
    subject = `Second reminder, rent overdue: ${property.name}, was due ${fmtDate(dueDate)}`;
    intro = `This is a second reminder that rent${amountText} for ${property.name}, due on ${fmtDate(dueDate)}, is still outstanding and is now 3 days overdue. Please arrange payment as soon as possible, or get in touch if there is a problem.`;
  }

  const text = `Dear ${property.tenant},\n\n${intro}${bank}\n\n${ignore}\n\nKind regards,\n${fromName}`;
  return { fromName, replyTo, subject, text };
}

// ----- text messages (the iPhone Shortcut sends these from your own number) ----
const cleanPhone = (v) => String(v || '').replace(/[^\d+]/g, '');

const fmtShort = (d) =>
  new Date(toMs(d)).toLocaleDateString('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' });

function buildText(snapshot, item) {
  const { property, dueDate, stage } = item;
  const settings = snapshot.settings || {};
  const fromName = property.ownerName || settings.landlordName || '';
  const first = String(property.tenant || '').trim().split(/\s+/)[0] || 'there';
  const amountText = property.rent ? ` of ${money(property.rent)}` : '';
  const sign = fromName ? ` ${fromName}` : '';
  const d = fmtShort(dueDate);

  if (stage === 'before') {
    return `Hi ${first}, a reminder that rent${amountText} for ${property.name} is due on ${d}. Payment details are in your email. If you have already paid, please ignore this.${sign}`;
  }
  if (stage === 'due') {
    return `Hi ${first}, rent${amountText} for ${property.name} is due today. Payment details are in your email. If you have already paid, please ignore this.${sign}`;
  }
  if (stage === 'late1') {
    return `Hi ${first}, rent${amountText} for ${property.name} was due yesterday (${d}) and has not been received yet. Please pay today if you can, or let me know if there is a problem.${sign}`;
  }
  return `Hi ${first}, rent${amountText} for ${property.name} is now 3 days overdue (due ${d}). Please arrange payment as soon as possible, or get in touch.${sign}`;
}

// Example wording for the first property that has a due day, so you can read all four texts.
function sampleTexts(snapshot, today) {
  const { upcoming } = planReminders(snapshot, today);
  const prop = (snapshot.properties || []).find((p) => Number(p.dueDay) && p.email);
  const u = prop && upcoming.find((x) => x.property === prop.name);
  if (!prop || !u) return [];
  return STAGES.map((s) => ({
    stage: s.stage,
    property: prop.name,
    body: buildText(snapshot, { property: prop, dueDate: u.dueDate, stage: s.stage }),
  }));
}

export async function planTexts({ markSent = false, todayOverride } = {}) {
  const store = getStore('ledger');
  const snapshot = await store.get('snapshot', { type: 'json', consistency: 'strong' });
  if (!snapshot) {
    return { ok: false, error: 'No data has been synced yet. In the app, tap "Sync data now" first.' };
  }

  const today = todayOverride || melbourneToday();
  const textLog = (await store.get('text-log', { type: 'json', consistency: 'strong' })) || {};
  const { items } = planReminders(snapshot, today);

  const messages = [];
  const skipped = [];
  let changed = false;

  for (const item of items) {
    const key = `${item.property.id}|${item.dueDate}|${item.stage}`;
    const base = {
      property: item.property.name,
      tenant: item.property.tenant,
      stage: item.stage,
      dueDate: item.dueDate,
    };
    if (textLog[key]) {
      skipped.push({ ...base, reason: 'already-texted' });
      continue;
    }
    if (item.paid) {
      skipped.push({ ...base, reason: 'paid' });
      continue;
    }
    const to = cleanPhone(item.property.phone);
    if (!to) {
      skipped.push({ ...base, reason: 'no-mobile' });
      continue;
    }
    messages.push({ ...base, to, body: buildText(snapshot, item) });
    if (markSent) {
      textLog[key] = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    const cutoff = addDays(today, -150);
    for (const k of Object.keys(textLog)) {
      if (textLog[k].slice(0, 10) < cutoff) delete textLog[k];
    }
    await store.setJSON('text-log', textLog);
  }

  const out = { ok: true, today, markedAsHandedOver: markSent, messages, skipped };
  if (!markSent) out.samples = sampleTexts(snapshot, today);
  return out;
}

// ----- main runner (used by the HTTP action and by the daily schedule) -------
export async function runReminders({ dryRun = false, todayOverride } = {}) {
  const store = getStore('ledger');
  const snapshot = await store.get('snapshot', { type: 'json', consistency: 'strong' });
  if (!snapshot) {
    return { ok: false, error: 'No data has been synced yet. In the app, tap "Sync data now" first.' };
  }

  const today = todayOverride || melbourneToday();
  const sentLog = (await store.get('sent-log', { type: 'json', consistency: 'strong' })) || {};
  const { items, upcoming } = planReminders(snapshot, today);

  const results = [];
  let transporter = null;
  let logChanged = false;

  for (const item of items) {
    const key = `${item.property.id}|${item.dueDate}|${item.stage}`;
    const base = {
      property: item.property.name,
      tenant: item.property.tenant,
      stage: item.stage,
      dueDate: item.dueDate,
    };

    if (sentLog[key]) {
      results.push({ ...base, action: 'already-sent' });
      continue;
    }
    if (item.paid) {
      results.push({ ...base, action: 'skipped-paid' });
      continue;
    }
    if (dryRun) {
      results.push({ ...base, action: 'would-send' });
      continue;
    }

    try {
      if (!transporter) {
        transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
        });
      }
      const mail = buildEmail(snapshot, item);
      await transporter.sendMail({
        from: `"${mail.fromName}" <${process.env.GMAIL_USER}>`,
        replyTo: mail.replyTo,
        to: item.property.email,
        subject: mail.subject,
        text: mail.text,
      });
      sentLog[key] = new Date().toISOString();
      logChanged = true;
      results.push({ ...base, action: 'sent' });
    } catch (err) {
      results.push({ ...base, action: 'error', error: String((err && err.message) || err) });
    }
  }

  if (logChanged) {
    const cutoff = addDays(today, -150);
    for (const k of Object.keys(sentLog)) {
      if (sentLog[k].slice(0, 10) < cutoff) delete sentLog[k];
    }
    await store.setJSON('sent-log', sentLog);
  }

  return {
    ok: true,
    today,
    dryRun,
    lastSynced: snapshot.savedAt,
    results,
    upcoming,
  };
}

// ----- HTTP handler -----------------------------------------------------------
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!process.env.APP_SHARED_SECRET || body.shared_secret !== process.env.APP_SHARED_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    if (body.action === 'sync') {
      const d = body.data || {};
      const props = Array.isArray(d.properties) ? d.properties : [];
      const pays = Array.isArray(d.payments) ? d.payments : [];
      const store = getStore('ledger');

      // Safety: a freshly reinstalled app has no data; never let that wipe the server copy.
      const existing = await store.get('snapshot', { type: 'json', consistency: 'strong' });
      if (props.length === 0 && existing && existing.properties && existing.properties.length) {
        return json(
          { ok: false, error: 'Refused: the app has no properties but the server does. Not overwriting.' },
          409,
        );
      }

      const s = d.settings || {};
      const snapshot = {
        savedAt: new Date().toISOString(),
        settings: {
          landlordName: str(s.landlordName),
          landlordEmail: str(s.landlordEmail),
          bankDetails: str(s.bankDetails, 600),
        },
        properties: props.slice(0, 50).map((p) => ({
          id: str(p.id, 60),
          name: str(p.name),
          tenant: str(p.tenant),
          email: str(p.email),
          rent: str(p.rent, 20),
          dueDay: Number(p.dueDay) || 0,
          ownerName: str(p.ownerName),
          ownerEmail: str(p.ownerEmail),
          paymentDetails: str(p.paymentDetails, 600),
          phone: str(p.phone, 30),
        })),
        payments: pays.slice(0, 2000).map((p) => ({
          propertyId: str(p.propertyId, 60),
          periodStart: str(p.periodStart, 10),
          periodEnd: str(p.periodEnd, 10),
          date: str(p.date, 10),
          amount: str(p.amount, 20),
        })),
      };
      await store.setJSON('snapshot', snapshot);
      return json({
        ok: true,
        savedAt: snapshot.savedAt,
        properties: snapshot.properties.length,
        payments: snapshot.payments.length,
      });
    }

    if (body.action === 'reminders') {
      const result = await runReminders({
        dryRun: body.dry_run !== false, // default to a safe preview
        todayOverride: /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : undefined,
      });
      return json(result, result.ok ? 200 : 400);
    }

    if (body.action === 'texts-preview') {
      const result = await planTexts({
        markSent: false,
        todayOverride: /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : undefined,
      });
      return json(result, result.ok ? 200 : 400);
    }

    if (body.action === 'texts') {
      // Always uses the real date and always marks messages as handed over.
      const result = await planTexts({ markSent: true });
      return json(result, result.ok ? 200 : 400);
    }

    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500);
  }
};
