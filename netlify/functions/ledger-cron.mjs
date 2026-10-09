import { runReminders } from './ledger-api.mjs';

// Runs every day at 22:00 UTC, which is 9:00am Melbourne time in daylight saving
// (8:00am in winter). Netlify schedules are always in UTC.
export default async () => {
  const result = await runReminders({ dryRun: false });
  console.log(JSON.stringify(result));
};

export const config = {
  schedule: '0 22 * * *',
};
