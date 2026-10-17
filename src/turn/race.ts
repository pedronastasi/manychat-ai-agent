/**
 * Settles with `work`, or with `'deadline'` at `deadlineAt`, whichever comes
 * first (C7). The deadline is a point in time, not a duration, so a wait that
 * came before the race counts against it (specs/037). `work` is never
 * cancelled: a caller that loses the race decides what becomes of it.
 */
export async function raceDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T | 'deadline'> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>(resolve => {
    timer = setTimeout(() => resolve('deadline'), Math.max(0, deadlineAt - Date.now()));
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
