/**
 * Dane planu ruchów magazynowych dla dystrybutora HoReCa.
 * Plik zawiera wyłącznie dane i czyste funkcje odczytujące te dane - bez importów i bez I/O.
 *
 * Wszystko jest deterministyczne z rozmysłem: bez Math.random i bez Date.now. Rotacja liczona
 * przez pricing_engine z tych ruchów musi wyjść tak samo przy każdym przebiegu, inaczej cena
 * zmienia się dlatego, że seeder rzucił kostką, a takiej ceny nikt nie zaudytuje.
 */

/** Sześć miesięcy - mieści się w 180-dniowym oknie rotacji silnika i daje pełny odczyt. */
export const MOVEMENT_HISTORY_MONTHS = 6

export const WEEKS_PER_MONTH = 4

export const DAYS_PER_WEEK = 7

/** Co czwarty tydzień przyjeżdża dostawa uzupełniająca - typowy cykl zamówień u dostawcy. */
export const RECEIPT_EVERY_WEEKS = 4

/**
 * Docelowe dni pokrycia, rozrzucone pozycyjnie zamiast losowo - wzorem REMAINING_LIFE_PATTERN
 * z lotSeeder.ts. Rozrzut wokół domyślnych 30 dni jest celowy: demo, w którym każdy produkt
 * rotuje tak samo, nigdy nie pokaże, że zmierzona rotacja w ogóle zmienia koszt magazynu.
 */
export const TARGET_COVER_DAYS_PATTERN = [18, 24, 31, 40, 52, 27, 21, 35, 45, 60, 29, 23, 38, 48]

/**
 * Sezonowość tygodniowa. Trzynaście pozycji, czyli kwartał - długość celowo nie dzieli się przez
 * cykl dostaw, więc przyjęcia nie wypadają zawsze na ten sam poziom sprzedaży.
 */
export const SEASONAL_WEEK_MULTIPLIERS = [
  0.82, 0.9, 1.05, 1.18, 1.32, 1.24, 1.1, 0.96, 0.88, 1.0, 1.14, 1.28, 1.36,
]

/** Przestrzeń nazw dla deterministycznych identyfikatorów dokumentów źródłowych. */
export const MOVEMENT_REFERENCE_NAMESPACE = '6f9f4d6c-2a9f-4c7d-9a3b-1f5c0d2e7b41'

export const MOVEMENT_IDEMPOTENCY_PREFIX = 'horeca-seed'

export function targetCoverDaysFor(index: number): number {
  const pattern = TARGET_COVER_DAYS_PATTERN
  return pattern[index % pattern.length] ?? 30
}

export function seasonalMultiplierFor(weeksAgo: number): number {
  const pattern = SEASONAL_WEEK_MULTIPLIERS
  return pattern[(weeksAgo - 1) % pattern.length] ?? 1
}

export function historyWeeksFor(months: number): number {
  const requested = Number.isFinite(months) && months > 0 ? Math.floor(months) : MOVEMENT_HISTORY_MONTHS
  return requested * WEEKS_PER_MONTH
}
