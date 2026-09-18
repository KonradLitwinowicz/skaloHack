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

Osiem plików bazowych wymaga drobnych zmian — rejestracja modułów, mapowanie
ścieżek w testach, wystawienie `CatalogProductUnitConversion` w DI katalogu oraz
dopisanie `pricing-engine` do etapu `runner` w `Dockerfile`.

```bash
cd <open-mercato> && git apply /sciezka/do/patches/open-mercato-0.7.0-integration.patch
```

Łatka dotyka: `Dockerfile`, `eslint.ds.config.mjs`, `yarn.lock`,
`apps/mercato/package.json`, `apps/mercato/jest.config.cjs`,
`apps/mercato/src/modules.ts`, `packages/core/src/modules/catalog/di.ts`,
`packages/cli/src/lib/generators/__tests__/module-facts.bc-guard.test.ts`.

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

W Dockerze każdą z nich poprzedź
`docker compose -f docker-compose.fullapp.yml exec app`.

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
| `packages/pricing-engine/` | Silnik wyceny cost-to-serve |
| `apps/mercato/src/modules/distributor_workspace/` | Workspace dystrybutora, rola `distributor`, seedery HoReCa |
| `patches/open-mercato-0.7.0-integration.patch` | Zmiany w ośmiu plikach bazowych |
| `.ai/specs/` | Specyfikacje obu modułów |
| `docs/SPEC.md` | Specyfikacja silnika wyceny |
| `URUCHOMIENIE.md` | Uruchomienie przez Docker od zera |
| `deploy-vps.sh` | Wysyłka na nasz VPS (skrypt wewnętrzny, wymaga wpisu `halfycraft` w `~/.ssh/config`) |
