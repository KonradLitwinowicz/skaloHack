# Silnik wyceny (`pricing_engine`) — jak to uruchomić

Instrukcja dla osoby, która widzi ten projekt pierwszy raz. Nie trzeba znać Open Mercato
ani mieć zainstalowanego Node'a — wystarczy Docker.

---

## Co to jest

Open Mercato (platforma e-commerce/ERP, licencja MIT) z dołożonym modułem **`pricing_engine`** —
silnikiem wyceny dla dystrybutora B2B (hurt HoReCa: chemia, opakowania, papier).

Silnik odpowiada na pytanie, na które w typowym systemie nikt nie odpowiada:
**ile naprawdę kosztuje nas obsłużenie tego konkretnego klienta na tej konkretnej pozycji**
— i jaka cena przy tym koszcie utrzymuje założony zarobek.

Cena powstaje z uporządkowanego ciągu składowych (koszt zakupu → koszt pracy ludzi → marża →
bezpieczniki → zaokrąglenie), a **każda wycena jest zapisywana z pełnym rozbiciem**: co weszło
do rachunku, z jakimi stawkami i jednozdaniowe uzasadnienie po polsku, które handlowiec może
przeczytać klientowi.

> **Silnik działa w trybie `shadow`.** Liczy i zapisuje, ale **nie zmienia żadnej ceny**
> w koszyku, ofercie ani zamówieniu. To celowe — przed przełączeniem na tryb bojowy trzeba
> najpierw porównać jego ceny z tymi, które faktycznie fakturowano.

---

## Wymagania

- **Docker** w wersji 24 lub nowszej, z `docker compose` (nie stary `docker-compose`).
- **~8 GB wolnego RAM-u** i **~15 GB miejsca na dysku** — to monorepo, obraz jest duży.
- Wolne porty: `3000` (aplikacja), `5432` (Postgres), `6379` (Redis), `7700` (Meilisearch).
  Jeśli któryś jest zajęty, patrz sekcja *Zajęte porty*.

Pierwszy build trwa **15–30 minut**. Kolejne uruchomienia to kilkanaście sekund.

---

## Uruchomienie

### 1. Plik `.env`

W katalogu głównym projektu (obok `docker-compose.fullapp.yml`) utwórz plik `.env`:

```bash
printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
```

`JWT_SECRET` to jedyna rzecz, którą **musisz** ustawić — bez niej stack celowo nie wstanie.
Nie ma wartości domyślnej, bo opublikowany sekret pozwoliłby każdemu podrobić token logowania.

Klucze do AI (`OPENAI_API_KEY` itd.) **nie są potrzebne** do silnika wyceny. Bez nich kontenery
`opencode` i `mcp` będą się restartować — to nie przeszkadza aplikacji. Jeśli wolisz ciszę w logach,
uruchom sam rdzeń:

```bash
docker compose -f docker-compose.fullapp.yml up --build app postgres redis meilisearch
```

### 2. Start

```bash
docker compose -f docker-compose.fullapp.yml up --build
```

Przy **pierwszym** starcie kontener aplikacji sam wykona `yarn mercato init`, czyli:
założy bazę, wykona wszystkie migracje (w tym 20 tabel `pricing_*`), nada uprawnienia rolom
i zaseeduje dane demonstracyjne. Zajmuje to kilka minut po zakończeniu builda.

Gotowe, gdy w logach zobaczysz nasłuch na porcie 3000.

### 3. Logowanie

Otwórz **http://localhost:3000/backend**

| | |
|---|---|
| e-mail | `superadmin@acme.com` |
| hasło | `secret` |

(Do zmiany przez `OM_INIT_SUPERADMIN_EMAIL` / `OM_INIT_SUPERADMIN_PASSWORD` w `.env`,
ustawione **przed** pierwszym startem.)

---

## Co obejrzeć

W lewym menu pojawi się grupa **Wycena** z dwoma ekranami.

### Wycena → Playground cenowy
`http://localhost:3000/backend/pricing/playground`

Serce demo. Wpisujesz produkt i ilość, wybierasz **scenariusz zamówienia** (jak klient złożył
zamówienie), klikasz *Policz cenę* i dostajesz cenę wraz z **wodospadem składowych**: od kosztu
zakupu, przez każdą składową, do ceny końcowej. Przy każdej składowej widać wartość, sumę bieżącą,
znacznik pewności danych i zdanie wyjaśniające.

**Potrzebujesz ID produktu.** Weź je z `Katalog → Produkty` — wejdź w dowolny produkt i skopiuj
UUID z adresu URL. Seed zakłada pozycje zakupowe dla pierwszych 50 produktów z katalogu.

**Rzecz, którą warto pokazać jako pierwszą:** ta sama pozycja, ta sama ilość, zmieniony wyłącznie
scenariusz zamówienia — *Plik w naszym formacie* kontra *Telefon*. Cena rośnie, bo obsługa telefonu
realnie kosztuje więcej. Rozrzut kosztu obsługi (ok. 3,60 zł ↔ ok. 25,60 zł na zamówienie) jest
skalibrowany na danych dystrybutora, nie wymyślony.

### Wycena → Pokrycie danymi
`http://localhost:3000/backend/pricing/coverage`

Ekran celowo nieprzyjemny. Pokazuje **wszystkie 11 składowych** docelowego silnika i mówi wprost,
która naprawdę liczy, a która jeszcze nie istnieje; skąd bierze dane i czy są one zmierzone,
oszacowane, czy założone. Działa 5 z 11 — i ekran to przyznaje, zamiast ukrywać.

To jest ekran dla osoby decyzyjnej: pokazuje, na czym silnik stoi, zanim ktoś uwierzy w liczby.

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

Dostępne końcówki:

| Metoda | Ścieżka | Do czego |
|---|---|---|
| `POST` | `/api/pricing/quote` | Wycena koszyka; **zapisuje** wyliczenie do księgi audytowej |
| `POST` | `/api/pricing/simulate` | To samo, ale **nic nie zapisuje** — do scenariuszy „co gdyby" |
| `GET` | `/api/pricing/calculations/:id` | Odtworzenie zapisanej wyceny z pełnym rozbiciem |
| `GET` | `/api/pricing/coverage` | Rejestr pokrycia danymi |

---

## Co jest prawdziwe, a co założone — przeczytaj, zanim uwierzysz w liczby

To nie jest formalność. Silnik ma jedną nadrzędną zasadę: **nigdy nie udawać, że coś jest zmierzone,
kiedy jest zgadnięte.**

**Skalibrowane na realnych danych dystrybutora:**
mediana narzutu 66%, spadek narzutu wraz z wolumenem zakupu, rozrzut kosztu obsługi zamówienia
zależnie od kanału (plik ↔ telefon).

**Założone przeze mnie, oznaczone w systemie jako `Założone` (`default`):**
stawki godzinowe ról (handlowiec 85 zł/h, magazynier 48 zł/h, kierowca 55 zł/h, księgowość 75 zł/h,
windykacja 90 zł/h, narzut 22%), czasy kroków procesu, koszt miejsca w magazynie, flota, strefy
dostaw. Każda z tych wartości jest do podmiany z poziomu aplikacji — docelowy dystrybutor wpisuje
własne. Widać je na ekranie pokrycia jako założenia.

**Wygenerowane syntetycznie:** koszty zakupu i progi rabatowe dla produktów demo. Wszystkie rekordy
demo mają w bazie znacznik `is_demo = true`.

**Świadomie NIE zaimplementowane w tym etapie** (widoczne na ekranie pokrycia jako
*Niezaimplementowana*): koszt pakowania, koszt magazynu, koszt dostawy, cechy produktu,
profil klienta i efekt wolumenu — czyli 6 z 11 składowych.

Dodatkowo: **wskaźniki klienta nigdy nie będą „zmierzone" na obecnych danych** — dostępna historia
jest agregatem per produkt i nie zawiera klienta ani koszyka. Kiedy powstaną, będą oznaczone jako
szacowane, a ekran pokrycia pokaże brakujące źródło.

---

## Typowe problemy

**Zajęte porty.** Dopisz do `.env` przed startem:
```
APP_PORT=3010
POSTGRES_PORT=5433
REDIS_PORT=6380
```

**„set JWT_SECRET in the .env file".** Brakuje pliku `.env` lub zmiennej — patrz krok 1.

**Kontenery `opencode` / `mcp` się restartują.** Brak klucza do dostawcy AI. Nie ma to wpływu
na silnik wyceny; można je pominąć przy starcie (patrz krok 1).

**Grupa „Wycena" nie widać w menu.** Zaloguj się jako `superadmin@acme.com`. Jeśli dalej nie ma:
```bash
docker compose -f docker-compose.fullapp.yml exec app yarn mercato auth sync-role-acls
```

**Playground zwraca „Brak zapisanego kosztu zakupu".** Ten produkt nie ma pozycji zakupowej —
seed tworzy je tylko dla pierwszych 50 produktów. Weź inny produkt. To zachowanie jest celowe:
silnik woli powiedzieć, że nie ma kosztu, niż go wymyślić.

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
| `lib/components/` | Jedna składowa ceny = jeden plik |
| `lib/pipeline.ts` | Kolejność składowych i sposób ich składania |
| `lib/decimal.ts` | **Jedyne** miejsce z arytmetyką pieniężną (BigInt, bez floatów) |
| `lib/params.ts` | Rozwiązywanie parametrów: wersjonowanie w czasie + hierarchia zakresów |
| `lib/seedDefaults.ts` | Założone stawki startowe |
| `data/entities.ts` | 20 encji |
| `__tests__/` | 32 testy, w tym golden cases |

Testy bez Dockera (wymaga Node'a i `yarn install`):

```bash
yarn workspace @open-mercato/pricing-engine test
```

Tryb deweloperski z podmontowanym kodem i przeładowaniem:

```bash
docker compose -f docker-compose.fullapp.dev.yml up --build
```

Dokumentacja projektowa: [`.ai/specs/2026-09-18-pricing-engine-module.md`](.ai/specs/2026-09-18-pricing-engine-module.md)
(model danych, wzory składowych, ryzyka, plan kolejnych etapów).
Zasady pracy nad modułem: [`packages/pricing-engine/AGENTS.md`](packages/pricing-engine/AGENTS.md).
