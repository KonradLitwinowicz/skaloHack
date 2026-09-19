# Handoff — lewy pasek dystrybutora ułożony według procesu

Autor: Wojtek (przez Claude Code), 2026-09-19. Gałąź `fix/distributor-sidebar`, bazuje na `a37aca4`.
Zastępuje trzy grupy z Dostawy D (`daily` / `records` / `pricingSettings`). Decyzja właściciela:
menu ma prowadzić dystrybutora po jego procesie, od góry do dołu.

## Nowy układ (dla roli `distributor`)

| Grupa (`app.nav.groups.*`) | Pozycje |
|---|---|
| `sales` — Sprzedaż | **Pulpit** (wstrzyknięty), Przewidywane zamówienia, Oferty, Zamówienia |
| `pricing` — Wycena | Kalkulator marży, Doradca cenowy, Zapas martwy i rotacja |
| `customers` — Klienci | Firmy, Osoby, (szanse — gdy rola ma uprawnienia), Zadania, Kalendarz, Wiadomości |
| `stock` — Towar i magazyn | Produkty, Kategorie, Magazyn (+ podstrony WMS zagnieżdżone po ścieżce) |
| `claims` — Reklamacje | bez zmian |
| `pricingPolicy` — Polityka cenowa | Reguły marży, Bezpieczniki cenowe, Cele i wagi |
| `serviceCosts` — Koszty obsługi | Koszty zakupu, Stawki pracy, Kroki procesu, Scenariusze zamówień, Koszty magazynu, Koszty pakowania, Strefy dostaw, Pojazdy, Ceny paliwa |

Ukryte z paska (nadal działają pod adresem): dotychczasowe cztery + **`/backend/sales/documents/create`**
(akcja, nie miejsce — listy ofert i zamówień mają przycisk tworzenia) i **`/backend/storage/attachments`**
(przeglądarka plików platformy).

## Jak to jest zrobione

- **`apps/mercato/src/modules.ts`** (w `patches/open-mercato-0.7.0-integration.patch`, też w szablonie
  `create-app`): nowe `distributorNavGroups`. `DistributorNavPage` ma opcjonalne `titleKey`/`title` —
  zmienia nazwę strony z core **tylko w pasku** (nagłówek strony zostaje z modułu): `customer-tasks` →
  Zadania, `catalog/products` → Produkty, `wms` → Magazyn.
- **Pulpit**: `/backend` to strona aplikacji, nie route modułu, więc nadpisanie jej nie przeniesie.
  Jest wstrzyknięty widżetem `distributor_workspace/widgets/injection/sidebar-dashboard` do spotu
  `menu:sidebar:main` z `groupId: 'app.nav.groups.sales'` i `placement: First`. **Zmieniając id grupy
  `sales`, zmień je też w widżecie.**
- **Nazwy ekranów wyceny zmienione u źródła** (i18n `pricing_engine`, więc menu i nagłówek są zgodne):
  Doradca marży → **Doradca cenowy**, Rotacja i deadstock → **Zapas martwy i rotacja**, Barierki cenowe →
  **Bezpieczniki cenowe** (spójnie z nazwą komponentu silnika; wszystkie 10 tekstów „barierka” w pl,
  z odmianą), Pozycje zakupowe → **Koszty zakupu**. Tekst podpowiedzi z dawną ścieżką „Wycena →
  Parametry → Barierki cenowe” wskazuje teraz „Polityka cenowa → Bezpieczniki cenowe”.
- **i18n aplikacji** (`apps/mercato/src/i18n` + szablon): usunięte `app.nav.groups.{daily,records,pricingSettings}`,
  dodane nowe grupy i `app.nav.items.{customerTasks,products,warehouse}` we wszystkich 5 językach.

## Testy

`__tests__/navigationGroups.test.ts` (i kopia w szablonie):
- „wszystkie tabele parametrów w grupie ustawień” → w **dwóch** grupach (`pricingPolicy` + `serviceCosts`),
  które są ostatnie,
- nowy: grupa `sales` jest pierwsza i ma kolejność prognoza → oferty → zamówienia,
- nowy: każdy `titleKey` ma tłumaczenie en/pl,
- asercja metadanych nadpisania obejmuje `titleKey`/`title`.

Stan: 271/271 `distributor_workspace`, 602/602 `pricing-engine`, typecheck aplikacji czysty.
Łatka integracyjna sprawdzona `git apply --check` na czystym `v0.7.0`; podmienione wyłącznie sekcje
12 plików (2× `modules.ts`, 10× słowniki), pozostałe 28 bez zmian.

## Wdrożenie do drzewa 0.7.0

Moduły jak zwykle (skopiuj `distributor_workspace`, `pricing-engine`), a pliki bazowe:
wycofaj poprzednią wersję łatki i nałóż nową — albo nałóż tylko różnicę dla 12 plików. Potem
`yarn generate` (nowy widżet wstrzyknięcia) i restart `yarn dev`.
