# Handoff — pricing_engine: limit rabatu, zaokrąglanie nad progiem, jednostki wymiarów

Autor zmiany: Wojtek (przez Claude Code), 2026-09-19. Gałąź `fix/pricing-engine-guardrail-gaps`,
bazuje na `791c49d`. Dotyka WYŁĄCZNIE `packages/pricing-engine/` (+ ten plik i `AGENTS.md` pakietu).
Moduł `distributor_workspace`, łatka integracyjna i pliki bazowe Open Mercato — bez zmian.

Przeczytaj przed pracą nad `guardrails.ts`, `rounding.ts`, `productAspects.ts`, formularzem
bezpieczników albo podglądem „wpływ ceny na klienta”.

## Po co

Przegląd kodu silnika (stan `791c49d`) znalazł luki między tym, co specyfikacja i komentarze
obiecują, a tym, co kod robi. Poprawione są te, które właściciel uznał za błędy:

| # | Luka | Było | Jest |
|---|---|---|---|
| 1 | `max_discount_percent` | zapisywany i wyświetlany, NIGDZIE nie ograniczał ceny (pytanie otwarte w DMW „Business inputs”) | ogranicza **cenę negocjowaną** — patrz niżej |
| 2 | Zaokrąglenie po bezpiecznikach | `rounding` (poz. 11) mógł zejść o grosz poniżej marży min./ceny min.; test to dokumentował (`7.9952` zamiast ≥ `8`) | zaokrągla W GÓRĘ, gdy zwykłe zaokrąglenie przebiłoby próg |
| 3 | Mnożnik bezpiecznika zapisany do 4 miejsc | cena po `mul` mogła wylądować ułamek grosza pod progiem | pokryte przez #2 (zaokrąglenie podnosi na siatkę ≥ próg) |
| 4 | Jednostki wymiarów | `productAspects` przy braku `unit` zakładał `cm`; `warehouseCost` uznawał wymiary za nieużywalne | oba: brak jednostki = nieznana (ostrzeżenie), zgodnie z D6 „zero wymyślonych danych” |
| 5 | Komentarz w `pricingAdvisorService.ts` | twierdził, że odfiltrowuje sugestie poniżej progu marży — takiego filtra nie ma | komentarz mówi prawdę (i jest spójny z regułą w `AGENTS.md`: filtra NIE dodawać) |

## Decyzje właściciela (nie zmieniaj bez pytania)

- **D-A. Limit rabatu dotyczy tylko ceny negocjowanej.** To jedyne miejsce, gdzie cenę ustala
  człowiek, a nie silnik. Cena silnika sama w sobie nie jest ograniczana.
- **D-B. Limit NIE działa, gdy otwarta jest drabina terminowa albo podłoga zapasu martwego.**
  Te przeceny to świadome pozwolenie na zejście głębiej niż polityka; limit nie może go odbierać.
- **D-C. Brak kosztu zakupu / danych dostawy nadal daje 0 z ostrzeżeniem** (bez blokady). Świadomie
  NIE zmienione.
- **D-D. `product_aspects` nadal mnoży cały dotychczasowy koszt** (także magazyn i dostawę). Świadomie
  NIE zmienione.

## Nowe kontrakty w kodzie

**Limit rabatu (`lib/components/guardrails.ts`)**
- `maxDiscountFloor(target, maxDiscountPercent)` (eksport): `target × (1 − cap%)`; `null` gdy brak
  limitu albo cap poza (0, 100).
- Kolejność: cena negocjowana → (jeśli brak drabiny/deadstock) podniesienie do `maxDiscountFloor` →
  zwykłe progi (`floor_price`, `min_margin`) → drabina/deadstock. Marża minimalna nadal wygrywa, gdy
  leży wyżej niż limit rabatu.
- Gdy limit zadziałał: `explainKey` `…guardrails.explain.max_discount`, ostrzeżenie
  `pricing_engine.warnings.maxDiscountEnforced`, `params.effectiveFloorSource = 'max_discount'`,
  `params.maxDiscountFloorUnitPrice`.
- `api/customer-pricing-impact/route.ts`: `FLOOR_SOURCES` zawiera `max_discount`; widżet ma etykietę
  `pricing_engine.customerPricing.floorSource.maxDiscount`.

**Próg dla zaokrąglenia**
- `ComponentComputeArgs.priorResults?` (NOWE, opcjonalne): pełne wyniki komponentów już policzonych
  na tej linii. Ustawiane przez `lib/pipeline.ts`. Opcjonalne, żeby testy liczące jeden komponent w
  izolacji nie musiały go podawać.
- Guardrail zawsze, gdy obowiązuje jakikolwiek próg, wystawia `params.roundingFloorUnitPrice` =
  maksimum z: `floor_price`, ceny dla marży minimalnej, limitu rabatu (bez drabiny) albo podłogi
  drabiny/deadstock (z drabiną). Także wtedy, gdy próg NIE przesunął ceny.
- `rounding.ts` czyta ten próg z `priorResults`; jeśli zwykłe zaokrąglenie (albo końcówka
  „charm”) dałoby mniej, bierze najmniejszą cenę na siatce ≥ próg. `explainKey`
  `…rounding.explainKeptAboveFloor`, `inputs.floorUnitPrice`.
- Uwaga: `effectiveFloorSource`/`effectiveFloorUnitPrice` zachowują DOTYCHCZASOWĄ semantykę (tylko
  gdy próg zadziałał albo drabina otwarta) — podgląd wpływu ceny na nich polega.

**Wymiary (`productAspects.ts`)**
- Brak `dimensions.unit` → `unitRecognized: false` + `productAspectsDimensionUnitUnknown`, mnożnik 1.
- Czyta `length`, gdy nie ma `depth` — tak jak `warehouseCost`. (Katalog nie ma klucza `length`,
  pułapka #6 w handoffie z 18.09 dalej prawdziwa; to tylko spójność obu czytników.)

**Parametry / API / formularz**
- `data/validators.ts`: `maxDiscountPercent` w `guardrailShape`, zakres 0 ≤ x < 100
  (`pricing_engine.params.errors.maxDiscountOutOfRange`).
- `api/guardrails/route.ts`: zapis przy create; przy update pole POMINIĘTE zostawia starą wartość,
  jawne `null` czyści.
- `lib/forms/guardrailFormConfig.tsx`: pole „Maksymalny rabat” edytowalne w create i edit, nowy opis
  `…guardrails.hint.maxDiscount`. Klucz `…hint.maxDiscountNotEnforced` USUNIĘTY ze wszystkich locale.

**i18n** — 6 nowych kluczy w en/pl/de/es/ko (posortowane): `components.guardrails.explain.max_discount`,
`warnings.maxDiscountEnforced`, `components.rounding.explainKeptAboveFloor`,
`params.guardrails.hint.maxDiscount`, `params.errors.maxDiscountOutOfRange`,
`customerPricing.floorSource.maxDiscount`.

## Skutki, które zobaczysz w liczbach

- **Efektywna podłoga ceny negocjowanej rośnie.** Przy danych demo (narzut 66% ⇒ marża 39,76%,
  limit 25%) cena negocjowana nie zejdzie poniżej `cena_silnika × 0,75` ≈ **19,7% marży** — wcześniej
  jedynym progiem była marża minimalna 8%. 25% to wartość demo (`seedDefaults.ts`) z listy pytań do
  właściciela; realną wartość trzeba ustalić.
- **Podgląd „wpływ ceny na klienta”** dla bardzo niskiej ceny proponowanej pokaże źródło progu
  `max_discount` zamiast `min_margin` (przy domyślnym limicie 25%).
- **Marża przy progu nie schodzi pod minimum**: tam, gdzie test oczekiwał `7.9952`, teraz jest
  `8.0266` (grosz w górę zamiast w dół).
- **Produkty z wymiarami bez jednostki** tracą korektę gabarytową. Seed HoReCa zapisuje `unit: 'cm'`,
  więc dane demo tego nie dotyka.
- `pipeline.golden.test.ts` — bez zmian, złote przypadki przechodzą.

## Testy

- Nowy `__tests__/guardrailGaps.test.ts` (15 przypadków): limit rabatu (w tym: marża min. wygrywa,
  brak limitu, brak negocjacji), próg raportowany bez przesunięcia ceny, zaokrąglanie nad progiem
  (siatka, ułamek grosza, końcówka charm, brak guardraila = stare zachowanie), wymiary bez jednostki,
  `length`.
- `__tests__/customerPricingImpact.test.ts`: przypadki testujące podłogę MARŻY MINIMALNEJ używają
  teraz `NO_CAP_GUARDRAIL` (fixture bez limitu), żeby zachować ich sens; oczekiwana marża
  `7.9952` → `8.0266`; dopisany przypadek na źródło `max_discount` i ostrzeżenie.
- Test drabiny „negocjowana cena powyżej podłogi drabiny zostaje” przechodzi BEZ zmian — to on
  wymusił decyzję D-B.
- Stan: 602/602 w pricing-engine, 269/269 w `distributor_workspace`, typecheck czysty, build OK.
  Zweryfikowane na Open Mercato 0.8.0 (u Wojtka); łatka nakłada się czysto na `791c49d`.

## Jak wciągnąć do lokalnego drzewa 0.7.0 (to nie jest repo git)

Z katalogu głównego Open Mercato (`git apply` działa też poza repozytorium):

```bash
# w klonie skaloHack po zmerge'owaniu PR:
git diff 791c49d..HEAD --relative=packages/pricing-engine > /tmp/pricing-guardrail-gaps.patch
# w drzewie Open Mercato 0.7.0:
git apply --directory=packages/pricing-engine --check /tmp/pricing-guardrail-gaps.patch
git apply --directory=packages/pricing-engine /tmp/pricing-guardrail-gaps.patch
npx turbo run build --filter=@open-mercato/pricing-engine
yarn workspace @open-mercato/pricing-engine test
yarn workspace @open-mercato/pricing-engine typecheck
```

Bez migracji: kolumna `max_discount_percent` już istnieje w `pricing_guardrails`.

## Otwarte pytania do właściciela

1. Realna wartość limitu rabatu (demo: 25%) — i czy ma być różna per grupa klientów (zakresy
   bezpieczników już to umożliwiają).
2. Czy brak kosztu zakupu ma kiedyś blokować wycenę (dziś świadomie 0 + ostrzeżenie, D-C).
3. Czy korekta gabarytowa ma mnożyć tylko magazyn i dostawę (dziś cały koszt, D-D).
