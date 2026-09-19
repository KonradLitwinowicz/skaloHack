ultracode

Repo: /home/sendej/Downloads/open-mercato-0.7.0 (Open Mercato 0.7.0).
Przeczytaj AGENTS.md w roocie PRZED czymkolwiek — obowiązuje bezwzględnie.
Potem przeczytaj .ai/specs/2026-09-18-distributor-margin-workspace.md (585 linii) —
to jest specyfikacja tej pracy, z decyzjami D1–D8 i dostawami A–G.
Towarzysząca: .ai/specs/2026-09-18-pricing-engine-module.md (silnik, Kroki 1–2 wdrożone).

## Cel biznesowy

Dystrybutor B2B (hurt HoReCa: chemia, opakowania, papier) wycenia zlecenia dla klientów.
System liczy przychód, koszty w rozbiciu (materiał, robocizna, pakowanie, magazyn, dowóz),
marżę i jawnie pokazuje PRZYJĘTE ZAŁOŻENIA. Dostawca symuluje zamówienia i sprawdza, jak
cena zmienia się od wolumenu. Klient w portalu TYLKO zamawia — nigdy nie widzi kosztów.

## Stan środowiska — ZWERYFIKOWANY, NIE SPRAWDZAJ OD NOWA

- To NIE jest repozytorium git. Brak brancha i PR-ów. Nie próbuj git commit/PR.
- Docker: mercato-postgres na porcie hosta 5433, mercato-redis 6380. Brak kontenera `app`,
  więc komendy walidacyjne idą LOKALNIE (`yarn X`), nie przez docker-exec.
- `yarn dev` → http://localhost:3000/backend. Serwer zwykle już stoi.
- Tenant 04b4e92a-94a3-4b7d-8a7e-2450fc538b23, org ca70e868-f639-41ce-b509-9681c802abce.
- Baza: `docker exec -i mercato-postgres psql -U postgres -d open-mercato -f -` (heredoc na stdin).

### Konta

| Rola | Login | Hasło |
|---|---|---|
| Operator dystrybutora (backend) | dystrybutor@acme.com | Dystrybutor123! |
| Superadmin | superadmin@acme.com | secret |
| Admin | admin@acme.com | secret |
| Klient portalu (6 kont) | horeca-<uchwyt>@portal.example | Klient123! |

Portal: http://localhost:3000/acme-corp/portal/ordering
Konta portalowe m.in.: horeca-szpital-wolski, horeca-hotel-wilanow-park,
horeca-kawiarnia-nowodworska-ziarno, horeca-stolowka-sochaczewska.

## PUŁAPKI — każda kosztowała godzinę, nie wdepnij ponownie

1. `POST /api/auth/login` przyjmuje FORM-ENCODED, nie JSON. JSON parsuje się do pustych
   danych i zwraca mylące 400. Używaj --data-urlencode.
2. `POST /api/customer_accounts/login` przyjmuje JSON, ale wymaga tenantId+organizationId
   w ciele, gdy wołasz po IP zamiast przez /{orgSlug}/portal/login.
3. SUPERADMIN WIDZI PUSTE LISTY na routach CRUD. Ścieżka ORM w makeCrudRoute
   (packages/shared/src/lib/crud/factory.ts:1985) zwraca pustkę, gdy ctx.organizationIds
   jest pustą tablicą — a u superadmina puste znaczy „wszystkie organizacje". To zachowanie
   platformy, nie błąd modułu. Testuj na dystrybutor@acme.com.
4. `export const metadata` w routcie API MUSI być LITERAŁEM OBIEKTOWYM. Generator czyta
   metadata.path statycznie ze źródła i nie rozwinie wywołania funkcji — ścieżka spadnie
   na /api/<module_id>/* i wszystko zwróci 404.
5. Zmiany w packages/* wchodzą do runtime przez dist. Po edycji:
   `npx turbo run build --filter=@open-mercato/pricing-engine`.
6. `catalog_products.dimensions` to {width, height, depth, unit} — NIE MA klucza `length`.
7. `wms_inventory_balances.quantity_available` jest kolumną GENEROWANĄ (onHand − reserved
   − allocated). Nigdy jej nie wstawiaj.
8. `wms_inventory_balances.catalog_variant_id` jest NOT NULL — zapas istnieje tylko per
   wariant. Dlatego każdy produkt ma wariant domyślny.
9. Klienci mają ZASZYFROWANE display_name, primary_email, description oraz wszystkie linie
   adresu, miasto i kod pocztowy. WHERE po nich trafia w szyfrogram. Idempotencja seedera
   opiera się na nieszyfrowanym polu `source` ('horeca:<uchwyt>').
10. Konta NIGDY przez API: signup wysyła maila weryfikacyjnego, admin/users emituje zdarzenie
    z kanałem e-mail. Seeduj przez em.create. OM_DISABLE_EMAIL_DELIVERY=1 jako druga obrona.
11. Test i18nKeys wymusza IDENTYCZNE zestawy kluczy w en i pl. Częściowy zapis wywala pakiet.
12. `markupFromMargin('100')` zwraca '0.0000' (narzut zero = sprzedaż po kosztach). Pole
    formularza już to odrzuca, ale pamiętaj przy każdej nowej konwersji.
13. Silnik przechowuje NARZUT na koszcie, ludzie myślą w MARŻY na cenie.
    marża = narzut/(1+narzut), narzut = marża/(1−marża). 66% narzutu = 39,76% marży.
14. Silnik liczy NETTO. Zero obsługi VAT w całym pakiecie.
15. Nowe encje edytowalne mają domyślnie blokadę optymistyczną (updated_at + updatedAt w API).

## Co jest zrobione i działa

Moduł aplikacyjny `apps/mercato/src/modules/distributor_workspace/`:
- seedery: katalog (200 produktów HoReCa w PLN, 22 kategorie, 87 wariantów opcyjnych,
  165 wariantów domyślnych, 400 przeliczników jednostek, 204 pozycje zakupowe z kosztem
  zakupu i progami rabatowymi), klienci (40 firm, 48 adresów z REALNYMI współrzędnymi),
  strefy dostaw (4, WYLICZONE ze współrzędnych klientów × współczynnik krętości 1,35),
  reguły marżowe (19 grup produktowych + 5 segmentów + 2 indywidualne + 3 limity),
  magazyn (1 depot, 48 lokalizacji, 200 stanów: 16 bez towaru, 26 pod progiem),
  partie (92 z terminami ważności, 14 traci termin w 30 dni = 20 227 PLN ryzyka),
  konta (1 backend + 6 portalowych), rola `distributor` z 40 uprawnieniami.
- portal klienta: frontend/[orgSlug]/portal/ordering/ + api/portal/{catalog,quote,requests}
- CLI: `yarn mercato distributor_workspace <komenda>`
  seed-horeca-catalog | seed-horeca-customers | seed-horeca-zones | seed-margin-rules |
  seed-horeca-warehouse | seed-horeca-lots | seed-distributor-accounts
  Wszystkie idempotentne, wszystkie z --dry-run i --count.

Pakiet `packages/pricing-engine/` (rozbudowany):
- 11 routów CRUD parametrów pod /api/pricing/* + 36 ekranów (lista/dodaj/edytuj)
- zakładka marży wstrzykiwana w sales.document.detail.{order,quote}:tabs
- kalkulator marży, doradca upsellowy (5 generatorów sugestii), symulator wolumenu
- komponenty: MarginSummary, MarginAssumptions, ConfidenceBadge, PriceWaterfall,
  DocumentMarginPanel; lib/frontend/{marginMath,quoteClient}
- i18n: 519 kluczy, parzystość en/pl, polski przetłumaczony

Walidacja na dzień przekazania: typecheck 26/26, lint czysty,
245 testów w pricing-engine + 44 w module aplikacyjnym.

## KOLEJKA — rób w tej kolejności

### 1. Duplikaty sugestii doradcy (małe, widoczne dla użytkownika)
`lib/advisor/suggestions/volumeThreshold.ts` buduje kandydatów jako sumę DRABINY OPAKOWAŃ
i mnożników wzrostu, a `fullPackRounding.ts` używa TEJ SAMEJ drabiny. Powstają identyczne
sugestie pod dwoma tytułami, a `maxPerKind` ogranicza tylko W OBRĘBIE rodzaju — nie ma
deduplikacji MIĘDZY rodzajami. Licznik mówi „6 sposobów", realnie są 3.
Rekomendacja: volumeThreshold przestaje proponować ilości z drabiny opakowań (rozłączne role),
alternatywnie runner deduplikuje po (productId, toQuantity) przed rankingiem.
Przy okazji: karta sugestii nie mówi, KTÓREGO produktu dotyczy — dodaj etykietę.

### 2. Drabina przecen terminowych (Dostawa G w specyfikacji — opisana, kod nie napisany)
Decyzje właściciela: drabina łagodna 25% → 10% → 5% pozostałego okresu przydatności;
koszt utylizacji rozliczany WAGOWO (założenie: 2,50 PLN/kg, 6,00 PLN/kg dla hazmat —
właściciel poda prawdziwą stawkę).
- powyżej 25% życia: normalny limit marży
- 25%–10%: podłoga spada do 5% marży
- 10%–5%: podłoga do 0% marży (sprzedaż po koszcie)
- poniżej 5%: podłoga = −(weightKg × stawka_utylizacji), czyli UJEMNA
Uzasadnienie: koszt zakupu jest utopiony. Wybór to „odzyskać coś" kontra „nie odzyskać nic".
Przy chemii utylizacja kosztuje, więc oddanie za złotówkę bije zniszczenie.
Wymagania: przecena TYLKO gdy istnieje partia z bliskim terminem (inaczej staje się zwykłym
rabatem z wymówką); przy zamówieniu większym niż przeceniana partia cena WAŻONA po partiach,
które FEFO faktycznie zużyje; panel mówi wprost „cena X poniżej kosztu o Y, bo partia L-...
traci termin za N dni, a alternatywą jest spisanie Z PLN"; każda przecena w księdze z id partii.
Pliki: lib/components/guardrails.ts, lib/catalog.ts (odczyt partii), lib/params.ts.
Dane gotowe: 92 partie, 84 profile na FEFO, terminy rozrzucone deterministycznie.

### 3. Rotacja magazynowa zamiast płaskich 30 dni
`lib/components/warehouseCost.ts:178` ma komentarz „no stock-history module exists yet" —
TO NIEPRAWDA, WMS istnieje i ma wms_inventory_movements, _balances, _lots, _product_inventory_profiles.
Dziś każdy produkt płaci identycznie za magazyn, niezależnie czy schodzi w tydzień czy leży rok.
Policz faktyczne dni pokrycia z ruchów magazynowych. UWAGA: ruchów jeszcze nie zaseedowano —
trzeba dosiać kilka miesięcy przyjęć i wydań, żeby rotacja liczyła się z faktów.
InventoryMovement wymaga performedBy (uuid), referenceType, referenceId, performedAt.

### 4. Cele i wagi dostawcy (Dostawa F — opisana, kod nie napisany)
Decyzja właściciela: cele definiuje SAM operator, pełna precedencja zakresów.
Mechanizm bez migracji: wiersz w pricing_component_params z component_code='objective_weights'.
Zweryfikowane: loadParameters wciąga WSZYSTKIE wiersze bez filtra po kodzie (lib/params.ts:102),
a componentPayload dopasowuje po dowolnym tekście z pełną precedencją (lib/params.ts:228).
Cel = { code, label, metric, direction: maximise|minimise, weight }.
metric MUSI być jedną z metryk, które wycena już emituje: marginPercent, profitNet, revenueNet,
unitCostNet, productCost, operationalCost, packagingCost, warehouseCost, logisticsCost.
Ranking = Σ waga × znormalizowana zmiana metryki. Panel pokazuje WKŁAD KAŻDEGO CELU osobno —
ranking, którego nikt nie umie rozebrać, to ranking, któremu nikt nie zaufa.
GUARDRAILE BIJĄ WAGI: żadne ważenie nie schodzi poniżej minimalnej marży.

### 5. Powtarzalne zamówienia obniżają koszt (decyzja podjęta, kod nie napisany)
Klient zamawiający wciąż to samo jest tańszy w obsłudze: znika negocjacja przy przyjęciu,
kompletacja idzie z szablonu. To SPADEK KOSZTU, nie rabat — marża procentowa zostaje,
klient płaci mniej, i to da się obronić przed klientem.
Mechanizm już istnieje: pricing_order_scenarios.step_multipliers skaluje czas każdego kroku.
Zaseedowane: ideal_file ×0,35 / nonstandard_file ×0,90 / email ×1,30 / sms ×2,30 /
phone ×2,47 / rep_visit ×4,00 na kroku order_intake.
Dodaj scenariusz `repeat_order` z niższym mnożnikiem na przyjęciu i kompletacji.
Otwarte: czy wykrywać powtarzalność z historii zamówień (trzeba dosiać zamówienia — nie ma
ich w bazie), czy przypisywać statycznie z monthlyOrderCount w danych klientów.
NIE mieszaj tego z komponentem customer_profile ze specyfikacji silnika — tamten mnoży CENĘ
i zjada marżę. Droga kosztowa jest uczciwsza.

### 6. Dekoracja sprzedaży — cena z silnika trafia na zamówienie (duże, Ask First)
Dziś pricing_engine NIE dekoruje salesCalculationService. Cena z panelu nie dociera do zamówienia.
ROZSTRZYGNIĘTE BADANIEM, nie powtarzaj go:
- SalesCalculationContext.resolve jest wypełniane przez ZERO miejsc w kodzie (sprawdzone na
  wszystkich 16 miejscach konstrukcji). Hook registerSalesLineCalculator NIE MA JAK sięgnąć
  po DI — to pułapka, nie szew.
- Kontekst niesie tylko tenantId, organizationId, currencyCode i metadata z {shippingMethod,
  paymentMethod}. NIE MA klienta ani id dokumentu. Cztery z pięciu zakresów parametrów są
  stamtąd nieosiągalne.
- Zalecenie z AGENTS.md pricing-engine, żeby rejestrować hook w di.ts, PROWADZI DO WYCIEKU
  MIĘDZY TENANTAMI: register(container) biegnie przy każdym żądaniu, salesCalculations jest
  globalne dla procesu, registerLineCalculator to bezwarunkowy push bez deduplikacji.
- Tryb `mode` NIC NIE ZNACZY: nic w pipeline go nie czyta, jest tylko stemplowany na wyniku.
  Każda własność bezpieczeństwa „trybu shadow" musi zostać dopiero napisana.
- pricingService.quote() woła em.flush() na EM żądania, poza transakcją sprzedaży — wiersze
  księgi zatwierdzają się przed zapisem zamówienia i przeżywają jego wycofanie.
- KOLIZJA WALUT: silnik wycenia w PLN, stare zamówienia i 4 demowe produkty są w USD.
Bezpieczna kolejność: (0) poprawić kłamiące komentarze w AGENTS.md pricing-engine i modules.ts;
(1) dekorator DI tylko zapisujący obserwacje, zero mutacji kwot; (2) naprawa raportowania trybu
+ UI tylko do odczytu; (3) sterowanie trybem z ACL i blokadą optymistyczną; (4) rozszerzenie
SalesCalculationContext o documentId/customerId — TO DOTYKA packages/core, pozycja Ask First;
(5) tryb live — świadoma decyzja właściciela po obejrzeniu danych z shadow.
Kroki 0–3 zostawiają wyjście sprzedaży BIT W BIT IDENTYCZNE.

### 7. Drobiazgi
- 4 stare produkty demo (buty, sukienka) mają pozycje zakupowe z grupami 'chemistry'/'packaging'
  i pokazują się w portalu HoReCa. Odfiltrować albo usunąć te pozycje.
- 4 nieprzetłumaczone klucze w pricing_engine/i18n/pl.json (identyczne z en) — sprawdzić czy
  to nazwy własne, czy przeoczenie.
- Menu backendu: 24 grupy / 96 pozycji głównych + 53 w Ustawieniach. Plan przebudowy pod
  personę dystrybutora jest w specyfikacji jako Dostawa D. Mechanizmy zweryfikowane:
  wstrzykiwanie menu jest TYLKO DODAJĄCE, preferencje sidebara NIE przenoszą pozycji między
  grupami, podmiana powłoki NIE JEST MOŻLIWA. Jedyne, co przegrupowuje: overrides.routes.pages
  + overrides.nav.groupOrder w apps/mercato/src/modules.ts.

## Jak pracować

1. Multiagentowo. Rozkładaj research i implementację na równoległe tory z ROZŁĄCZNYMI plikami —
   ustal właściciela każdego pliku przed startem. Nigdy nie pozwól dwóm agentom pisać do i18n:
   niech raportują klucze, a scalanie rób jednym przejściem.
2. Weryfikuj czytaniem kodu i żądaniem HTTP, nie raportem agenta. Dzisiejsza sesja złapała tak:
   nigdy niepodpięte przeliczniki jednostek, wymiary pisane pod nieistniejący klucz, nieistniejące
   pole `code`, 404 na wszystkich routach, wyciek treści błędu do klienta i pułapkę marży 100%.
   Każde z tych „przeszło testy".
3. Testy integracyjne w tej samej zmianie dla każdej nowej ścieżki API (.ai/qa/AGENTS.md).
   Własne fixture'y, sprzątanie w finally, zero polegania na danych demo.
4. Na koniec każdej części: yarn generate, yarn typecheck, yarn lint, testy obu pakietów,
   przebudowa pricing-engine. Powiedz wprost, co przeszło, a co nie — bez zamiatania.
5. PYTAJ przed `yarn db:migrate`. Migracje generuj i pokaż SQL.
6. Rozmawiaj po polsku.
