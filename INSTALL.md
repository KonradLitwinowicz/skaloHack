# Instalacja na istniejącym Open Mercato 0.7.0

To repozytorium **nie jest** kopią Open Mercato — zawiera wyłącznie to, co dokładamy
do czystej wersji **0.7.0**. Jeśli masz już postawione Open Mercato, poniższe kroki
dokładają silnik wyceny (`pricing_engine`) i workspace dystrybutora
(`distributor_workspace`).

Punkt wyjścia: czyste `open-mercato` w wersji `v0.7.0`.

```bash
git clone --branch v0.7.0 https://github.com/open-mercato/open-mercato.git
```

---

## 1. Skopiuj nowe moduły

Z tego repozytorium do katalogu Open Mercato, zachowując ścieżki:

```bash
cp -a packages/pricing-engine <open-mercato>/packages/pricing-engine
```
```bash
cp -a apps/mercato/src/modules/distributor_workspace <open-mercato>/apps/mercato/src/modules/distributor_workspace
```

## 2. Nałóż łatkę integracyjną

Pliki bazowe wymagają zmian — rejestracja modułów, mapowanie ścieżek w testach,
wystawienie `CatalogProductUnitConversion` w DI katalogu, dopisanie
`pricing-engine` do etapu `runner` w `Dockerfile`, a także przebudowa pulpitu
(`DashboardScreen`, widżety sprzedaży i klientów, układ pulpitu) oraz zmiany
w WMS pod wykrywanie zapasu martwego.

```bash
cd <open-mercato> && git apply /sciezka/do/patches/open-mercato-0.7.0-integration.patch
```

Łatka obejmuje **46 plików**: 40 zmodyfikowanych i 6 nowych, tworzonych przez
`git apply` (m.in. `packages/ui/src/backend/dashboard/{WidgetList.tsx,useDashboardColumns.ts,widgetIcon.tsx}`
oraz trzy zestawy testów). Sprawdzona pod `git apply --check` na czystym tagu
`v0.7.0` — nakłada się bez konfliktów.

Świadomie **nie** zawiera dwóch plików: `packages/core/src/modules/wms/migrations/.snapshot-open-mercato.json`
(szum regeneratora — moduł `wms` nie ma nowej migracji, więc wzięcie tego
wygenerowałoby fałszywe migracje) oraz
`packages/ui/src/backend/icons/lucideRegistry.generated.tsx` (odtwarza go
`yarn generate` w kroku 3).

> Bez zmiany w `Dockerfile` build produkcyjny przechodzi ~7 minut kompilacji,
> a potem pada na `yarn workspaces focus @open-mercato/app --production`
> z komunikatem `Workspace not found (@open-mercato/pricing-engine)`.
> Dockerfile powtarza listę workspace'ów trzy razy i w etapie `runner` brakowało
> jednej linii.

## 3. Zbuduj

```bash
yarn install
```
```bash
yarn generate && yarn build:packages
```

## 4. Migracje

```bash
yarn db:migrate
```

## 5. Dane demonstracyjne

Seedery HoReCa uruchamia się ręcznie i **kolejność ma znaczenie** — konta portalowe
wymagają wcześniej utworzonych klientów, a partie magazynowe katalogu i magazynu:

```bash
yarn mercato distributor_workspace seed-horeca-catalog
```
```bash
yarn mercato distributor_workspace seed-horeca-customers
```
```bash
yarn mercato distributor_workspace seed-distributor-accounts
```
```bash
yarn mercato distributor_workspace seed-horeca-zones
```
```bash
yarn mercato distributor_workspace seed-margin-rules
```
```bash
yarn mercato distributor_workspace seed-horeca-warehouse
```
```bash
yarn mercato distributor_workspace seed-horeca-lots
```
```bash
yarn mercato distributor_workspace seed-horeca-movements
```
```bash
yarn mercato distributor_workspace seed-horeca-order-history
```

W Dockerze każdą z nich poprzedź
`docker compose -f docker-compose.fullapp.yml exec app`.

> Wiek zapasu i rotację licz ze sprzedaży, nie z `wms_inventory_movements` —
> seeder ruchów magazynowych generuje równy rytm, przez który każdy wskaźnik
> oparty na samych ruchach wychodzi płaski i bezużyteczny.

---

## Konta po zaseedowaniu

Portal klienta działa pod `/<slug-organizacji>/portal/login` — przy domyślnej
organizacji Acme Corp jest to `/acme-corp/portal/login`.

| Konto | Hasło | Rola |
|---|---|---|
| `*@portal.example` (klienci HoReCa) | `Klient123!` | Buyer |
| `alice.johnson@example.com` | `Password123!` | Portal Admin |
| `bob.smith@example.com` | `Password123!` | Buyer |
| `carol.white@example.com` | `Password123!` | Viewer |

Hasła pochodzą z kodu seedów i są przeznaczone wyłącznie do demo —
przed jakimkolwiek wystawieniem instancji na zewnątrz trzeba je zmienić.

---

## Co jest w tym repozytorium

| Ścieżka | Zawartość |
|---|---|
| `packages/pricing-engine/` | Silnik wyceny cost-to-serve, doradca, wykrywanie zapasu martwego |
| `apps/mercato/src/modules/distributor_workspace/` | Workspace dystrybutora, rola `distributor`, portal zamawiania, prognoza zamówień, 9 seederów HoReCa |
| `packages/create-app/template/src/modules/distributor_workspace/` | Ten sam moduł w szablonie `create-app` (wymóg Template Sync Checklist) |
| `patches/open-mercato-0.7.0-integration.patch` | 46 plików bazowych: 40 zmodyfikowanych, 6 nowych |
| `.ai/specs/` | Specyfikacje czterech obszarów |
| `.ai/lessons/`, `.ai/handoff/` | Wnioski z wdrożenia i notatka przekazania |
| `docs/SPEC.md` | Specyfikacja silnika wyceny |
| `URUCHOMIENIE.md` | Uruchomienie przez Docker od zera |
| `deploy-vps.sh` | Wysyłka na nasz VPS (skrypt wewnętrzny, wymaga wpisu `halfycraft` w `~/.ssh/config`) |
