/**
 * Weekday abbreviations for file exports, which carry no locale and no translator.
 *
 * The screens read weekday names through `useT` so they follow the operator's language; a CSV
 * opened in a spreadsheet has neither, and a bare ISO number in a column headed "Dzien" would make
 * the reader count on their fingers.
 */
export const EXPORT_WEEKDAY_LABELS = ['', 'Pn', 'Wt', 'Sr', 'Cz', 'Pt', 'So', 'Nd'] as const

export function exportWeekdayLabel(weekday: number | null): string {
  if (weekday === null) return ''
  return EXPORT_WEEKDAY_LABELS[weekday] ?? ''
}
