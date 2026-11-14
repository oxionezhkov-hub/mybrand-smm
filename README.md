# tasktracker

Личный Telegram-бот (Cloudflare Worker, `worker.js`) и страницы в `public/`. Ниже — входящие ассистента и уведомления о pull request: вопросы приходят в чат владельца, ответы уходят обратно агенту.

Базовый адрес ниже — `https://<worker>`. Это домен воркера `tasktracker` (workers.dev или свой).

## Входящие ассистента (Grok) и GitHub PR

Состояние лежит в уже подключённом KV (`binding = "KV"`). Новых привязок нет, секреты в репозиторий не коммитятся.

Ключи: `grok:q:<id>` (вопрос), `grok:cb:<token>` (кнопка → id), `grok:msg:<message_id>` (ответ на сообщение → id), `grok:pending` (ответы, которые агент ещё не забрал).

Статусы вопроса:

- `open` — ждёт ответа в Telegram;
- `answered` — Олег нажал кнопку или ответил на сообщение;
- `resolved` — закрыт через API («отвечено в другом месте») или PR смёржен/закрыт, пока по нему не висел незабранный ответ.

Отвечать может только чат из секрета `OWNER_CHAT_ID` — та же проверка, что у остальных команд бота.

### Секреты

```bash
# обязателен для /grok/*  (любая длинная случайная строка без пробелов)
wrangler secret put GROK_BRIDGE_TOKEN

# обязателен, чтобы POST /github/webhook принимал события
wrangler secret put GITHUB_WEBHOOK_SECRET

# необязательно: сразу POST-ить ответ агенту, не дожидаясь опроса
wrangler secret put GROK_ANSWER_WEBHOOK_URL
wrangler secret put GROK_ANSWER_WEBHOOK_TOKEN

# необязательно: кнопки Approve и Merge ходят в GitHub API.
# Без него выбор только записывается, агент забирает его через /grok/answers.
# Нужны права на pull requests (запись) и contents (запись), если Merge должен сливать PR.
wrangler secret put GITHUB_TOKEN
```

Уже должны быть заданы `TG_TOKEN` и `OWNER_CHAT_ID` — без них вопрос в Telegram не уходит.

Сгенерировать значение: `openssl rand -hex 32`.

### Вебхук Telegram

Новые маршруты не заменяют вебхук бота. Нужны апдейты `message` и `callback_query` на `https://<worker>/webhook` (POST на `/` тоже принимается). Если вебхук уже смотрит на этот воркер и `allowed_updates` не задан, ничего менять не надо. Если задан список — в нём должны быть оба типа.

Проверить и переустановить:

```bash
curl -s "https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo"

curl -s "https://api.telegram.org/bot${TG_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://<worker>/webhook\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

Кнопка или ответ (reply) на сообщение бота записывают ответ. Голосовой reply расшифровывается так же, как правки к рилсам. Чужой чат получает «Этот бот личный.» и ответ не сохраняется.

### Эндпоинты агента

Все `/grok/*` требуют заголовок `Authorization: Bearer <GROK_BRIDGE_TOKEN>`. Без секрета или с неверным токеном — `401 {"ok":false,"error":"unauthorized"}`.

Общий вид вопроса в ответах:

```json
{
  "id": "q_abc",
  "status": "open",
  "text": "Текст вопроса",
  "title": null,
  "options": [{ "id": "i0", "label": "Да" }],
  "source": "grok",
  "link": null,
  "answer": null,
  "option_id": null,
  "via": null,
  "telegram_message_id": 1001,
  "created_at": 1730000000000,
  "updated_at": 1730000000000,
  "answered_at": null,
  "acked_at": null,
  "resolved_at": null,
  "resolved_reason": null,
  "github": null,
  "github_action": null,
  "webhook_push": null
}
```

`via` — `button` или `reply`. Для кнопок GitHub `option_id` и `answer` равны `approve`, `merge`, `skip` или `looked` (на кнопках при этом написано Approve, Merge, «Посмотрел», «Пропустить»). Для своих вариантов `answer` — подпись кнопки, `option_id` — id из запроса (или `i0`, `i1`, …). Время — unix в миллисекундах.

#### `POST /grok/questions`

Создать вопрос и прислать его в чат. `id` необязателен (если нет — воркер выдаст `q_` + 16 hex). Повторный POST с тем же `id`, пока вопрос `open`, обновляет текст и правит сообщение (`200`, `"updated": true`). Если вопрос уже отвечен или закрыт — `409`.

```bash
curl -s -X POST "https://<worker>/grok/questions" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "lunch",
    "text": "Обед в 13:00?",
    "title": "Сегодня",
    "source": "grok",
    "link": "https://example.com/note",
    "options": ["Да", {"id": "no", "label": "Нет"}]
  }'
```

В примерах ниже у `question` оставлены только важные поля. Полный объект — как в списке полей выше.

Ответ `201`:

```json
{ "ok": true, "updated": false, "question": { "id": "lunch", "status": "open", "telegram_message_id": 1001 } }
```

`options` — до 8 строк или объектов `{ "id", "label" }`. `link` — только `http`/`https`. Если Telegram не принял сообщение, вопрос всё равно сохранён, ответ `502` с полем `telegram` — тот же `id` можно послать ещё раз.

В чате у вариантов будут кнопки. Свободный ответ — reply на это сообщение.

#### `GET /grok/questions`

Список. Параметры: `status=open|answered|resolved`, `unacked=1` (отвечены, но не забраны), `since=<мс>` (по `updated_at`, а для `unacked` — по `answered_at`). Не больше 100, при обрезке `"truncated": true`.

```bash
curl -s "https://<worker>/grok/questions?status=open" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN"
```

```json
{ "ok": true, "questions": [], "truncated": false }
```

#### `GET /grok/questions/:id`

Один вопрос. Не найден — `404 {"ok":false,"error":"not found"}`. `id` в пути нужно кодировать (`gh:owner__repo__72` → `gh%3Aowner__repo__72`).

```bash
curl -s "https://<worker>/grok/questions/lunch" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN"
```

#### `GET /grok/answers`

Очередь ответов из Telegram.

- без параметров — `answered` и ещё не забранные (`acked_at == null`), старые сначала;
- `?since=<мс>` — все ответы с `answered_at >= since`, включая уже забранные (курсор вместо ack);
- `?since=<мс>&unacked=1` — пересечение.

```bash
curl -s "https://<worker>/grok/answers" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN"
```

```json
{
  "ok": true,
  "answers": [
    {
      "id": "lunch",
      "status": "answered",
      "answer": "Да",
      "option_id": "i0",
      "via": "button",
      "answered_at": 1730000001000,
      "acked_at": null
    }
  ],
  "truncated": false
}
```

#### `POST /grok/answers/ack` и `POST /grok/questions/:id/ack`

Пометить ответы забранными. Повторный ack того же id успешен и не меняет первый `acked_at`. Неизвестный id попадает в `missing`, ещё открытый — в `skipped`.

```bash
curl -s -X POST "https://<worker>/grok/answers/ack" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"ids":["lunch"]}'
```

```json
{ "ok": true, "acked": ["lunch"], "missing": [], "skipped": [] }
```

Один id: `POST /grok/questions/lunch/ack` → `{ "ok": true, "question": { ... } }`.

#### `POST /grok/questions/:id/resolve` и `DELETE /grok/questions/:id`

Олег ответил в самом ассистенте. Бот удаляет сообщение в Telegram. Если удалить нельзя (например, сообщение старше ограничений Telegram), текст заменяется на «Отвечено в другом месте.» / `answered elsewhere`. Статус становится `resolved`, в очередь `/grok/answers` вопрос больше не попадает. Повторный вызов — `"already": true`.

```bash
curl -s -X POST "https://<worker>/grok/questions/lunch/resolve" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"answer":"Да, в 13:00","reason":"answered_elsewhere"}'
```

```json
{ "ok": true, "id": "lunch", "already": false, "telegram": "deleted", "status": "resolved", "question": {} }
```

`telegram`: `deleted`, `edited`, `gone` (сообщения уже нет), `failed`, `skipped`, `already_resolved`. `reason` — строка `[a-z0-9_]{1,40}`, по умолчанию `answered_elsewhere`. `answer` необязателен. Тело у `DELETE` тоже необязательно.

#### `POST /grok/questions/resolve`

То же для пачки, до 50 id. Ненайденные id не роняют весь запрос.

```bash
curl -s -X POST "https://<worker>/grok/questions/resolve" \
  -H "Authorization: Bearer $GROK_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"ids":["lunch","dinner"],"reason":"sync"}'
```

```json
{
  "ok": true,
  "results": [
    { "id": "lunch", "ok": true, "telegram": "deleted", "status": "resolved" },
    { "id": "dinner", "ok": false, "error": "not found" }
  ]
}
```

### Исходящий вебхук ответа

Если задан `GROK_ANSWER_WEBHOOK_URL`, сразу после ответа в Telegram воркер делает POST (таймаут 5 с). Ошибка доставки не отменяет ответ: агент всё равно увидит его в `GET /grok/answers`. Результат попытки пишется в `webhook_push` (`pushed`, `ok`, `status` или `error`).

```http
POST <GROK_ANSWER_WEBHOOK_URL>
Authorization: Bearer <GROK_ANSWER_WEBHOOK_TOKEN>   # только если секрет задан
Content-Type: application/json
X-Grok-Event: question.answered
X-Grok-Question: lunch
```

```json
{ "event": "question.answered", "question": { "id": "lunch", "status": "answered", "answer": "Да" } }
```

### Вебхук GitHub

`POST /github/webhook`. Подпись тела: заголовок `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 секрета GITHUB_WEBHOOK_SECRET>`. Неверная подпись — `401`. Секрет не задан — `503`.

В каждом репозитории: Settings → Webhooks → Add webhook.

- Payload URL: `https://<worker>/github/webhook`
- Content type: `application/json`
- Secret: то же значение, что у `wrangler secret put GITHUB_WEBHOOK_SECRET`
- SSL: включена
- События: «Let me select individual events» → **Pull requests**
- `ping` отвечает `{ "ok": true, "pong": true }`

Что публикуется в чат как вопрос (заголовок PR, репозиторий, автор, ссылка, кнопки Approve / Merge / Посмотрел / Пропустить / ссылка):

- `opened` и `reopened`, если PR не draft;
- `ready_for_review`;
- `review_requested` (в тексте будет ревьюер).

Черновик на `opened` пропускается (`"ignored": true, "reason": "draft"`). Повтор того же `opened` не шлёт второе сообщение (`already_seen`), а пока вопрос ещё `open` — правит уже отправленное. Если Олег уже ответил и агент ответ не забрал, новый `review_requested` / `reopened` / `ready_for_review` присылает отдельное сообщение и не стирает предыдущий ответ из очереди. Id вопроса: `gh:<owner>__<repo>__<номер>`.

`closed`: сообщение удаляется (или заменяется на «PR смёржен» / «PR закрыт», если удалить нельзя).

- PR ещё без ответа → статус `resolved`, `resolved_reason` = `github_merged` или `github_closed`;
- ответ уже есть и агент его не забрал → статус остаётся `answered`, вопрос остаётся в `GET /grok/answers`, в `github.state` будет `merged` или `closed`.

Кнопки:

- **Approve** — `POST /repos/{owner}/{repo}/pulls/{n}/reviews` с `{"event":"APPROVE","body":"Approved from Telegram"}`, если задан `GITHUB_TOKEN`;
- **Merge** — `PUT /repos/{owner}/{repo}/pulls/{n}/merge` с `{"merge_method":"merge"}`;
- **Посмотрел** / **Пропустить** — только запись ответа (`option_id`: `looked` / `skip`).

Нет `GITHUB_TOKEN` или GitHub вернул ошибку — выбор всё равно сохраняется (`github_action.skipped_reason = "no_token"` или `github_action.ok = false` и текст ошибки). Агент забирает его обычным `GET /grok/answers`.

### Проверка

```bash
node --import ./grok/test-register.mjs --test grok/bridge.test.mjs
```
