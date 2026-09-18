# Silnik wyceny (`pricing_engine`) — jak to uruchomić

Instrukcja dla osoby, która widzi ten projekt pierwszy raz.

> **Przeczytaj to najpierw.** To repozytorium zawiera **tylko jeden moduł** — katalog
> `packages/pricing-engine/` — a nie całą platformę. **Samo z siebie się nie uruchomi.**
> Moduł jest wtyczką do Open Mercato 0.7.0 i żeby go zobaczyć w działaniu, trzeba go najpierw
> wszczepić do działającej kopii Open Mercato. Cała ta instrukcja o tym właśnie jest.

---

## Co to jest

Moduł **`pricing_engine`** — silnik wyceny dla dystrybutora B2B (hurt HoReCa: chemia, opakowania,
papier), napisany jako pakiet do Open Mercato (platforma e-commerce/ERP, licencja MIT).

Silnik odpowiada na pytanie, na które w typowym systemie nikt nie odpowiada:
**ile naprawdę kosztuje nas obsłużenie tego konkretnego klienta na tej konkretnej pozycji**
— i jaka cena przy tym koszcie utrzymuje założony zarobek.

Cena powstaje z uporządkowanego ciągu składowych (koszt zakupu → koszt obsługi → narzut docelowy →
bezpieczniki → zaokrąglenie), a **każda wycena jest zapisywana z pełnym rozbiciem**: co weszło
do rachunku, z jakimi stawkami i jednozdaniowe uzasadnienie po polsku, które handlowiec może
przeczytać klientowi.

> **Silnik działa w trybie `shadow`.** Liczy i zapisuje, ale **nie zmienia żadnej ceny**
> w koszyku, ofercie ani zamówieniu. To celowe — przed przełączeniem na tryb bojowy trzeba
> najpierw porównać jego ceny z tymi, które faktycznie fakturowano.
> (Tryb jest polem `mode` w tabeli `pricing_supplier_profiles`; domyślna wartość to `'shadow'`.)

> **Stan zaawansowania, bez upiększania.** Docelowy silnik ma 11 składowych ceny.
> **Zaimplementowanych i działających jest 5.** Pozostałe 6 jest zadeklarowanych w kodzie po to,
> żeby ekran „Pokrycie danymi" wypisał je jako *Niezaimplementowane* — brak składowej ma być
> widoczny, a nie niewidoczny.

---

## Wymagania

- **Docker** w wersji 24 lub nowszej, z `docker compose` (nie stary `docker-compose`).
- **Node.js 24** i **Yarn 4 (przez Corepack)** — potrzebne lokalnie, żeby wykonać krok
  `yarn install` / `yarn generate` na połączonym repozytorium przed zbudowaniem obrazu.
- **Git**.
- **~8 GB wolnego RAM-u** i **~15 GB miejsca na dysku** — Open Mercato to monorepo, obraz jest duży.
- Wolny port **3000** na hoście (aplikacja). Postgres, Redis i Meilisearch działają wyłącznie
  w sieci wewnętrznej Dockera i **nie zajmują portów hosta**.

Pierwszy build obrazu trwa **15–30 minut**. Kolejne uruchomienia to kilkanaście sekund.

---

## Krok po kroku

### 1. Zdobądź Open Mercato 0.7.0

Moduł jest napisany i przetestowany pod wersję **0.7.0**. Inna wersja może wymagać poprawek.

```bash
git clone https://github.com/open-mercato/open-mercato.git
cd open-mercato
git checkout v0.7.0
```

Dalej w instrukcji katalog, w którym wylądowałeś, nazywam **katalogiem głównym**.

### 2. Wgraj moduł

Skopiuj katalog `packages/pricing-engine/` z **tego** repozytorium do `packages/` w katalogu
głównym Open Mercato:

```bash
cp -r /ścieżka/do/tego/repo/packages/pricing-engine ./packages/pricing-engine
```

Po tym kroku musi istnieć plik `packages/pricing-engine/package.json`.

### 3. Dodaj zależność workspace do aplikacji

W pliku `apps/mercato/package.json`, w sekcji `"dependencies"`, dopisz (lista jest alfabetyczna —
wstaw między `@open-mercato/onboarding` a `@open-mercato/queue`):

```json
"@open-mercato/pricing-engine": "workspace:*",
```

Bez tej linii Yarn nie zwiąże pakietu z aplikacją i import `@open-mercato/pricing-engine`
nie zadziała.

### 4. Włącz moduł w `apps/mercato/src/modules.ts`

W tablicy `enabledModules` znajdź wpis `sales` i **bezpośrednio po nim** dopisz nowy:

```ts
  { id: 'sales', from: '@open-mercato/core' },
  // MUST stay after `sales`: DI registrars run in this order, and pricing_engine decorates
  // the `salesCalculationService` binding that `sales` registers.
  { id: 'pricing_engine', from: '@open-mercato/pricing-engine' },
  { id: 'warranty_claims', from: '@open-mercato/core' },
```

**Dlaczego akurat po `sales`?** Rejestratory kontenera DI (Awilix) wykonują się w kolejności z tej
tablicy. Kto rejestruje klucz później, ten go nadpisuje. Moduł `sales` rejestruje
`salesCalculationService`; docelowo `pricing_engine` ma ten serwis owinąć własnym, więc musi być
**po** nim, inaczej `sales` nadpisałby dekorację.

> **Uczciwie:** w obecnym kodzie (`packages/pricing-engine/src/modules/pricing_engine/di.ts`)
> ten szew **nie jest jeszcze podpięty** — `di.ts` rejestruje wyłącznie `pricingService` oraz klasy
> encji, i nie dotyka `salesCalculationService`. Kolejność jest więc na dziś kontraktem na
> przyszłość, a nie twardym wymogiem runtime'u. Mimo to **trzymaj ją**: tak stanowi
> `packages/pricing-engine/AGENTS.md`, tak jest w referencyjnej aplikacji i tak będzie, gdy
> dekoracja dojdzie.

### 5. Dopisz moduł do `Dockerfile`

`Dockerfile` kopiuje manifesty pakietów *przed* `yarn install`, żeby warstwa z zależnościami
nie unieważniała się przy każdej zmianie kodu. Każdy nowy pakiet trzeba tam wymienić z osobna.

W `Dockerfile` są **trzy** takie bloki. W każdym wstaw nową linię między wpisem `onboarding`
a wpisem `queue` (lista jest alfabetyczna).

**Etap `builder`** i **etap `dev-build`** — obu dotyczy ta sama linia:

```dockerfile
COPY packages/pricing-engine/package.json ./packages/pricing-engine/
```

**Etap `runner`** — ten blok kopiuje manifesty `--from=builder`, więc linia wygląda inaczej:

```dockerfile
COPY --from=builder /app/packages/pricing-engine/package.json ./packages/pricing-engine/
```

Sprawdzenie: `grep -c pricing-engine Dockerfile` ma zwrócić `3`.

> **Nie pomijaj trzeciej linii.** `docker compose -f docker-compose.fullapp.yml` buduje ostatni etap
> `Dockerfile`, czyli `runner`, a `runner` uruchamia `yarn workspaces focus @open-mercato/app
> --production`. Skoro `apps/mercato/package.json` deklaruje zależność `workspace:*` na
> `@open-mercato/pricing-engine`, brak manifestu tego pakietu w tym etapie wywali instalację.

### 6. Plik `.env`

W katalogu głównym (obok `docker-compose.fullapp.yml`) utwórz plik `.env`:

```bash
printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
```

`JWT_SECRET` to jedyna rzecz, którą **musisz** ustawić — bez niej stack celowo nie wstanie
(compose ma `${JWT_SECRET:?…}`). Nie ma wartości domyślnej, bo opublikowany sekret pozwoliłby
każdemu podrobić token logowania.

Klucze do AI (`OPENAI_API_KEY` itd.) **nie są potrzebne** do silnika wyceny. Bez nich kontenery
`opencode` i `mcp` będą się restartować — to nie przeszkadza aplikacji. Jeśli wolisz ciszę w logach,
uruchom sam rdzeń (patrz krok 8).

### 7. Instalacja zależności i generatory

W katalogu głównym:

```bash
corepack enable
yarn install
yarn generate
yarn db:generate
```

- `yarn install` zwiąże nowy pakiet z workspace'em (i zaktualizuje `yarn.lock` — to oczekiwane).
- `yarn generate` przeskanuje moduły i wygeneruje rejestry (m.in. `packages/pricing-engine/generated/`).
  Bez tego kroku ekrany i końcówki API modułu w ogóle się nie zarejestrują.
- `yarn db:generate` porówna encje ze snapshotem migracji. Moduł przychodzi z gotową migracją
  (`src/modules/pricing_engine/migrations/Migration20260918145559_pricing_engine.ts`, 20 tabel
  `pricing_*`) i ze swoim `.snapshot-open-mercato.json`, więc **komenda nie powinna wygenerować
  nic nowego**. Gdyby coś wypluła — skasuj wyprodukowany plik i sprawdź, czy skopiowałeś cały
  katalog `migrations/` razem z ukrytym plikiem snapshotu.

> **`yarn db:migrate` uruchamiaj tylko świadomie.** Przy starcie w Dockerze migracje wykonają się
> same (krok 8), nie trzeba ich odpalać ręcznie.

### 8. Start

```bash
docker compose -f docker-compose.fullapp.yml up --build
```

Sam rdzeń, bez kontenerów AI:

```bash
docker compose -f docker-compose.fullapp.yml up --build app postgres redis meilisearch
```

Przy **pierwszym** starcie kontener aplikacji sam wykona `yarn mercato init`, czyli: założy bazę,
wykona wszystkie migracje (w tym 20 tabel `pricing_*`), nada uprawnienia rolom (`pricing.*` dla
roli `admin`) i zaseeduje dane demonstracyjne — profil dostawcy, stawki, kroki procesu, scenariusze
zamówień, rejestr pokrycia oraz pozycje zakupowe dla pierwszych 50 produktów z katalogu.
Zajmuje to kilka minut po zakończeniu builda.

Gotowe, gdy w logach zobaczysz nasłuch na porcie 3000.

### 9. Logowanie

Otwórz **http://localhost:3000/backend**

| | |
|---|---|
| e-mail | `superadmin@acme.com` |
| hasło | `secret` |

To domyślne wartości `yarn mercato init`. Do zmiany przez `OM_INIT_SUPERADMIN_EMAIL` /
`OM_INIT_SUPERADMIN_PASSWORD` w `.env`, ustawione **przed** pierwszym startem.

---

## Co obejrzeć

W lewym menu pojawi się grupa **Wycena** z dwoma ekranami.

### Wycena → Playground cenowy
`http://localhost:3000/backend/pricing/playground`

Serce demo. Wpisujesz ID produktu i ilość, wybierasz **scenariusz zamówienia** (jak klient złożył
zamówienie), klikasz *Policz cenę* i dostajesz cenę wraz z **wodospadem składowych**: od kosztu
zakupu, przez każdą składową, do ceny końcowej. Przy każdej składowej widać wartość, sumę bieżącą,
znacznik pewności danych (*Zmierzone* / *Szacowane* / *Założone*) i zdanie wyjaśniające.

**Potrzebujesz ID produktu.** Weź je z `Katalog → Produkty` — wejdź w dowolny produkt i skopiuj
UUID z adresu URL. Seed zakłada pozycje zakupowe dla pierwszych 50 produktów z katalogu
(`DEMO_PRODUCT_LIMIT = 50` w `setup.ts`).

**Rzecz, którą warto pokazać jako pierwszą:** ta sama pozycja, ta sama ilość, zmieniony wyłącznie
scenariusz zamówienia — *Plik w naszym formacie* kontra *Telefon*. Cena rośnie, bo obsługa telefonu
realnie kosztuje więcej. Krok „przyjęcie zamówienia" wyceniony jest na ok. **3,60 zł** przy pliku
w naszym formacie i ok. **25,60 zł** przy telefonie (6 min × 85 zł/h × 1,22 narzutu = 10,37 zł przy
mnożniku 1; mnożniki to `0.35` i `2.47`). To tylko ten jeden krok — pełny koszt obsługi zamówienia
obejmuje jeszcze kompletację, pakowanie, wydanie i fakturowanie.

### Wycena → Pokrycie danymi
`http://localhost:3000/backend/pricing/coverage`

Ekran celowo nieprzyjemny. Pokazuje **wszystkie 11 składowych** docelowego silnika i mówi wprost,
która naprawdę liczy, a która jeszcze nie istnieje; skąd bierze dane i czy są one zmierzone,
oszacowane, czy założone.

**Działa 5 z 11 składowych** i ekran to przyznaje, zamiast ukrywać:

| Składowa | Status |
|---|---|
| Koszt zakupu (`product_cost`) | Działa |
| Koszt obsługi (`operational_cost_base`) | Działa |
| Koszt pakowania (`packaging_cost`) | Niezaimplementowana |
| Koszt magazynu (`warehouse_cost`) | Niezaimplementowana |
| Koszt dostawy (`logistics_cost`) | Niezaimplementowana |
| Cechy produktu (`product_aspects`) | Niezaimplementowana |
| Profil klienta (`customer_profile`) | Niezaimplementowana |
| Efekt wolumenu (`volume_effect`) | Niezaimplementowana |
| Narzut docelowy (`target_margin`) | Działa |
| Bezpieczniki (`guardrails`) | Działa |
| Zaokrąglenie (`rounding`) | Działa |

To jest ekran dla osoby decyzyjnej: pokazuje, na czym silnik stoi, zanim ktoś uwierzy w liczby.

> Uwaga dla czytających kod: w `lib/components/` leżą już pliki `packagingCost.ts`,
> `warehouseCost.ts`, `logisticsCost.ts` i `productAspects.ts` wraz z testami, ale **nie są
> wpięte** do listy `implementedComponents` w `lib/components/index.ts`, więc nie biorą udziału
> w wycenie. Obecność pliku nie znaczy, że składowa liczy.

---

## Sprawdzenie z konsoli (opcjonalnie)

```bash
# zaloguj się i zapamiętaj ciasteczko sesji
# Uwaga: logowanie przyjmuje DANE FORMULARZA, nie JSON. Wysłanie JSON-a kończy się
# ogólnym "Invalid email or password", bo parser widzi puste pola.
curl -s -c /tmp/om.jar -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'email=superadmin@acme.com' \
  --data-urlencode 'password=secret'

# rejestr pokrycia danymi
curl -s -b /tmp/om.jar http://localhost:3000/api/pricing/coverage

# wycena (podstaw prawdziwe UUID produktu)
curl -s -b /tmp/om.jar -X POST http://localhost:3000/api/pricing/quote \
  -H 'content-type: application/json' \
  -d '{"orderScenarioCode":"phone","lines":[{"productId":"<UUID>","quantity":"24"}]}'
```

Dopuszczalne kody scenariuszy: `ideal_file`, `nonstandard_file`, `email`, `sms`, `phone`,
`rep_visit`.

Dostępne końcówki:

| Metoda | Ścieżka | Do czego | Uprawnienie |
|---|---|---|---|
| `POST` | `/api/pricing/quote` | Wycena koszyka; **zapisuje** wyliczenie do księgi audytowej | `pricing.quote` |
| `POST` | `/api/pricing/simulate` | To samo, ale **nic nie zapisuje** — do scenariuszy „co gdyby" | `pricing.simulate` |
| `GET` | `/api/pricing/calculations/:id` | Odtworzenie zapisanej wyceny z pełnym rozbiciem | `pricing.audit.read` |
| `GET` | `/api/pricing/coverage` | Rejestr pokrycia danymi | `pricing.audit.read` |

---

## Co jest prawdziwe, a co założone — przeczytaj, zanim uwierzysz w liczby

To nie jest formalność. Silnik ma jedną nadrzędną zasadę: **nigdy nie udawać, że coś jest zmierzone,
kiedy jest zgadnięte.**

**Skalibrowane na realnych danych dystrybutora:**
mediana narzutu 66%, spadek narzutu wraz z wolumenem zakupu, rozrzut kosztu przyjęcia zamówienia
zależnie od kanału (plik ↔ telefon).

**Założone przeze mnie, oznaczone w systemie jako `Założone` (`default`):**
stawki godzinowe ról (handlowiec 85 zł/h, magazynier 48 zł/h, kierowca 55 zł/h, księgowość 75 zł/h,
windykacja 90 zł/h, narzut 22%), czasy kroków procesu, koszt miejsca w magazynie, flota, strefy
dostaw. Każda z tych wartości jest do podmiany z poziomu aplikacji — docelowy dystrybutor wpisuje
własne. Widać je na ekranie pokrycia jako założenia.

Nagłówek pliku `lib/seedDefaults.ts` mówi to samo jeszcze ostrzej: **każda liczba w seedzie jest
założeniem, nie pomiarem**, a wszystkie utworzone z niej rekordy mają `is_demo = true`.

**Wygenerowane syntetycznie:** koszty zakupu i progi rabatowe dla produktów demo.

**Świadomie NIE zaimplementowane w tym etapie** (widoczne na ekranie pokrycia jako
*Niezaimplementowana*): koszt pakowania, koszt magazynu, koszt dostawy, cechy produktu,
profil klienta i efekt wolumenu — czyli 6 z 11 składowych.

Dodatkowo: **wskaźniki klienta nigdy nie będą „zmierzone" na obecnych danych** — dostępna historia
jest agregatem per produkt i nie zawiera klienta ani koszyka. Kiedy powstaną, będą oznaczone jako
szacowane, a ekran pokrycia pokaże brakujące źródło.

**Czego NIE sprawdzono.** Moduł ma **83 testy jednostkowe w 7 plikach i wszystkie przechodzą**
(`yarn workspace @open-mercato/pricing-engine test`), w tym przypadki golden dla całego potoku.
Natomiast **nie został przetestowany na żywej bazie danych** — migracja, seed, ekrany i końcówki
API nie były uruchomione przeciwko działającemu Postgresowi. Pierwsze uruchomienie według tej
instrukcji jest jednocześnie pierwszym testem integracyjnym; traktuj je jak taki.

---

## Typowe problemy

**Build Dockera wywala się na `yarn workspaces focus … --production`.** Brakuje trzeciej linii
`COPY` w etapie `runner` — patrz krok 5.

**`yarn install` mówi, że nie zna `@open-mercato/pricing-engine`.** Albo katalog nie trafił do
`packages/`, albo brakuje wpisu w `apps/mercato/package.json` — kroki 2 i 3.

**„set JWT_SECRET in the .env file".** Brakuje pliku `.env` lub zmiennej — patrz krok 6.

**Zajęty port 3000.** Dopisz do `.env` przed startem:
```
APP_PORT=3010
```
Zmienne `POSTGRES_PORT` / `REDIS_PORT` nie istnieją w `docker-compose.fullapp.yml` — te usługi nie
publikują portów na hosta, więc nie ma tu czego zmieniać.

**Kontenery `opencode` / `mcp` się restartują.** Brak klucza do dostawcy AI. Nie ma to wpływu
na silnik wyceny; można je pominąć przy starcie (krok 8).

**Grupy „Wycena" nie widać w menu.** Zaloguj się jako `superadmin@acme.com`. Jeśli dalej nie ma —
najpierw sprawdź, czy `yarn generate` wykonało się po skopiowaniu modułu (krok 7), a potem:
```bash
docker compose -f docker-compose.fullapp.yml exec app yarn mercato auth sync-role-acls
```

**Playground zwraca „Brak zapisanego kosztu zakupu".** Ten produkt nie ma pozycji zakupowej —
seed tworzy je tylko dla pierwszych 50 produktów. Weź inny produkt. To zachowanie jest celowe:
silnik woli powiedzieć, że nie ma kosztu, niż go wymyślić.

**„Dla tej organizacji nie skonfigurowano profilu cenowego" (HTTP 409).** Seed modułu nie wykonał
się dla tej organizacji. Przy czystym starcie robi to `yarn mercato init`; przy dołożeniu modułu
do istniejącej bazy uruchom `yarn mercato seed:defaults`.

**Zacząć od zera:**
```bash
docker compose -f docker-compose.fullapp.yml down -v
docker compose -f docker-compose.fullapp.yml up --build
```
(`-v` kasuje bazę wraz z danymi.)

---

## Praca nad kodem

Moduł żyje w `packages/pricing-engine/src/modules/pricing_engine/`.

| Gdzie | Co |
|---|---|
| `lib/components/` | Jedna składowa ceny = jeden plik; `index.ts` decyduje, które są aktywne |
| `lib/pipeline.ts` | Kolejność składowych i sposób ich składania |
| `lib/decimal.ts` | **Jedyne** miejsce z arytmetyką pieniężną (BigInt, bez floatów) |
| `lib/params.ts` | Rozwiązywanie parametrów: wersjonowanie w czasie + hierarchia zakresów |
| `lib/seedDefaults.ts` | Założone stawki startowe |
| `data/entities.ts` | 20 encji |
| `migrations/` | Jedna migracja zakładająca 20 tabel `pricing_*` |
| `__tests__/` | 83 testy w 7 plikach, w tym przypadki golden |

Testy bez Dockera (wymaga Node'a i `yarn install` w katalogu głównym Open Mercato):

```bash
yarn workspace @open-mercato/pricing-engine test
yarn workspace @open-mercato/pricing-engine typecheck
```

Tryb deweloperski z podmontowanym kodem i przeładowaniem:

```bash
docker compose -f docker-compose.fullapp.dev.yml up --build
```

Dokumentacja projektowa: [`docs/SPEC.md`](docs/SPEC.md) (model danych, wzory składowych, ryzyka,
plan kolejnych etapów). Zasady pracy nad modułem:
[`packages/pricing-engine/AGENTS.md`](packages/pricing-engine/AGENTS.md).

> Pliki `packages/pricing-engine/README.md` i `packages/pricing-engine/AGENTS.md` są wierną kopią
> z monorepo i linkują do `.ai/specs/2026-09-18-pricing-engine-module.md`. W tym repozytorium ten
> sam dokument leży pod `docs/SPEC.md`.
