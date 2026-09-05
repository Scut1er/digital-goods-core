# Digital Goods Core

Ядро магазина цифровых товаров: заказы, эмуляция оплаты, выдача ключей через двух поставщиков-заглушек, сверка и витрина остатков.

Стек: Node.js 22 + TypeScript + Fastify + PostgreSQL 16.

## Быстрый старт

```bash
cp .env.example .env
docker compose up -d db
# Postgres опубликован на localhost:5433 (чтобы не конфликтовать с локальным PG)
npm install
npm run migrate
npm run seed
npm run dev
```

Или всё в Docker: `docker compose up --build`.

API: `http://localhost:3000`.

## API

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/orders` | `{"sku":"STEAM-TOPUP-500"}` → заказ `created` |
| `GET` | `/orders/:id` | статус + код после выдачи |
| `POST` | `/webhook/payment` | вебхук оплаты (контракт из ТЗ) |
| `GET` | `/catalog/stock` | горячая витрина остатков |
| `GET` | `/catalog/stock/explain` | `EXPLAIN` плана запроса |
| `GET` | `/admin/reconcile` | сверка paid-not-delivered / delivered-not-paid + ledger |
| `POST` | `/admin/recover` | дожать зависшие заказы |
| `POST` | `/providers/A/issue` | заглушка поставщика A |
| `POST` | `/providers/B/issue` | заглушка поставщика B |

### Оплата (заглушка)

Реального эквайринга нет. Шлите тот же контракт, что и гоночный тест:

```bash
curl -s -X POST http://localhost:3000/webhook/payment \
  -H 'content-type: application/json' \
  -d '{"event_id":"evt_1","order_id":"ord_...","status":"paid","amount":500,"currency":"RUB","created_at":"2025-01-01T12:00:00Z"}'
```

`200` = принято. Повтор с тем же `event_id` — no-op (`duplicate: true`).

## Прогон приёмочных сценариев

Нужен запущенный API + прогнанные migrate/seed.

### 1-2. 50 параллельных вебхуков + повтор `event_id`

```bash
npm run test:race
# PARALLEL=50 BASE_URL=http://127.0.0.1:3000 npm run test:race
```

Скрипт создаёт заказ, бьёт 50 разных `event_id` + один дубль одновременно, ждёт `delivered`, затем ещё раз шлёт тот же `event_id`. Ожидание: один `delivery_code`, статус не меняется.

### 3. Вебхук раньше заказа

`POST /webhook/payment` с несуществующим `order_id` → `200`, событие кладётся в `payment_events` (`applied=false`). Когда заказ появляется (или воркер поднимает orphan), оплата применяется. Повтор того же `event_id` ничего не ломает.

```bash
# ранний вебхук
curl -s -X POST http://localhost:3000/webhook/payment -H 'content-type: application/json' \
  -d '{"event_id":"evt_early","order_id":"ord_will_exist","status":"paid","amount":299,"currency":"RUB","created_at":"2025-01-01T12:00:00Z"}'

# затем создаём заказ с тем же id
curl -s -X POST http://localhost:3000/orders -H 'content-type: application/json' \
  -d '{"sku":"SUB-SPOTIFY-1M","id":"ord_will_exist"}'
```

### 4. Таймаут != отказ (ловушка)

```bash
npm run test:timeout
```

Форсит выдачу ключа и обрыв ответа. Повтор с тем же `request_id` возвращает **тот же код**, в пуле по `request_id` ровно один ключ.

### 5. Fallback A -> B

In-process (сам поднимает Fastify с A=всегда 5xx, B=ок):

```bash
npm run test:providers
```

Или против уже запущенного API:

```bash
# PowerShell
$env:PROVIDER_A_FAIL_RATE=1
$env:PROVIDER_A_TIMEOUT_RATE=0
$env:PROVIDER_B_FAIL_RATE=0
$env:PROVIDER_B_TIMEOUT_RATE=0
$env:PROVIDER_MAX_RETRIES=1
npm run dev

# другой терминал
$env:FALLBACK_MODE=1
npm run test:providers:http
```

Ожидание: `status=delivered`, `provider=B`, один код.

### 6. Пустой остаток

Исчерпайте ключи SKU (или `UPDATE inventory_keys SET status='sold'`), оплатите заказ. Статус `out_of_stock` (не падение). После пополнения пула: `POST /admin/recover` → `delivered`.

### Сверка

```bash
curl -s http://localhost:3000/admin/reconcile
# или
npm run reconcile
```

### Смоук (нужна БД)

```bash
npm test
```

## Ключевые решения

**Exactly-once оплаты.** `payment_events.event_id` PRIMARY KEY + `SELECT ... FOR UPDATE` на строке заказа. Параллельные `paid` сериализуются: ровно один переход `created → paid`, ровно одна запись `ledger_entries.payment_in`. Дубль `event_id` — ранний return.

**Exactly-once выдачи.** Стабильный `request_id = {orderId}-issue-{A|B}`. Поставщик пишет код в `provider_issue_log` (PK `request_id`) **до** ответа. Повтор после таймаута читает тот же лог — новый ключ не выделяется. `inventory_keys.request_id` unique + `FOR UPDATE SKIP LOCKED`. `orders.delivery_code` unique: второй bind физически невозможен.

**Таймаут != отказ.** Клиентский `Promise.race` обрывает ожидание, но аллокация в БД уже закоммичена. Перед fallback на B всегда смотрим `provider_issue_log`. Если код уже есть — привязываем его, B не зовём.

**Fallback AB.** A: ретраи с экспоненциальным бэкоффом на 5xx/timeout (тот же `request_id`). Только после исчерпания жёстких ошибок A и отсутствия кода в логе — B со своим `request_id`. `out_of_stock` — восстановимый статус, не fallback вслепую.

**Восстановление.** Воркер (`RUN_WORKER=true`) + `POST /admin/recover`: `FOR UPDATE SKIP LOCKED` по `paid|delivering|out_of_stock|delivery_failed` с `next_attempt_at <= now()`. Повтор безопасен из-за тех же уникальных ключей.

**Ledger.** `payment_in` = сумма заказа, `delivery_cost` = 0 (заглушка). Инвариант сверки: `SUM(ledger.amount) = SUM(payment_in)` и у каждого оплаченного заказа есть `payment_in`.

**Витрина (этап 5).** Не `COUNT(*)` по ключам. Денормализованный `product_stock.available_qty` обновляется триггером на `inventory_keys`. Частичный индекс `product_stock_available_idx (available_qty DESC, sku) WHERE available_qty > 0` + PK join на `products`. Ожидаемый план: Index Scan по partial index → Nested Loop на `products`. План живьём: `GET /catalog/stock/explain`. Seed кладёт 2000+ SKU.

## Как масштабировал бы

- Выдачу вынести в очередь (Postgres `SKIP LOCKED` / Redis / NATS), несколько воркеров уже безопасны.
- Горячий каталог: Redis/CDN поверх `product_stock`, инвалидация с триггера/`LISTEN`.
- Партиции `payment_events`, `delivery_attempts`, `ledger_entries` по месяцу.
- Идемпотентность на границе (unique + outbox) оставить в БД — это источник истины, не кэш.
- Реальные поставщики: тот же контракт `request_id`, таймаут + reconcile по их API status-by-request-id.

## Время

~4 часа чистой работы (схема, гонки, ловушка таймаута, сверка, витрина, тесты, README).
