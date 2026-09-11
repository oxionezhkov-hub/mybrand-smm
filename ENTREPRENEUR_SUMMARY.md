# Entrepreneur Content Summary

Автоматизированная система сбора и суммирования контента от предпринимателей с отправкой в Telegram.

## 📋 Как это работает

1. **Claude Code** запускает `collect_entrepreneur_summary.py`
2. Скрипт собирает статьи из RSS feeds и API
3. Claude AI суммирует каждую статью (2-3 предложения, actionable идеи)
4. Отправляет красивое HTML сообщение в Telegram через bot API

## 🚀 Установка

### Зависимости

```bash
pip install anthropic feedparser requests
```

### Переменные окружения

```bash
export CLAUDE_API_KEY="sk-..."          # Твой Claude API key
export TG_TOKEN="123456:ABC..."         # Telegram bot token
export WORKER_URL="https://bot.dev"     # URL твоего Cloudflare Worker (опционально)
```

## 📖 Использование

### Базовый запуск (отправляет в Telegram)

```bash
python collect_entrepreneur_summary.py
```

### Просмотр сообщения без отправки

```bash
python collect_entrepreneur_summary.py --dry-run
```

### С явным указанием параметров

```bash
python collect_entrepreneur_summary.py \
  --worker-url "https://tasktracker.example.com" \
  --token "YOUR_TG_TOKEN" \
  --claude-key "sk-..." \
  --limit 5
```

### Опции

- `--worker-url` — URL твоего Cloudflare Worker (по умолчанию: `$WORKER_URL`)
- `--token` — Telegram bot token (по умолчанию: `$TG_TOKEN`)
- `--claude-key` — Claude API key (по умолчанию: `$CLAUDE_API_KEY`)
- `--limit` — Макс. элементов с источника (по умолчанию: 5)
- `--dry-run` — Показать сообщение без отправки

## 📚 Источники контента

Скрипт собирает из:

- **Y Combinator News** — новости о стартапах
- **Paul Graham Essays** — классические эссе о предпринимательстве
- **Indie Hackers** — истории инди-разработчиков
- **Sam Altman Blog** — идеи от основателя Y Combinator
- **Dev.to** — статьи о стартапах и технологиях

Легко добавить свои источники в `ENTREPRENEUR_SOURCES`.

## 🔄 Автоматизация в Claude Code

### Вариант 1: Регулярный запуск

Используй `/loop` для периодического запуска:

```
/loop 1h python /path/to/collect_entrepreneur_summary.py
```

### Вариант 2: Через расписание

Добавь в `.claude/hooks.json`:

```json
{
  "schedule": {
    "daily-at-9am": {
      "cron": "0 9 * * *",
      "run": "python /path/to/collect_entrepreneur_summary.py"
    }
  }
}
```

### Вариант 3: Ручной запуск из Claude Code

Просто скажи Claude:
> "Собери и отправь сводку предпринимательского контента в бот"

Claude Code запустит скрипт с нужными параметрами.

## 📤 API Endpoint

Скрипт отправляет сообщение через:

**Endpoint:** `POST /api/send-summary`

**Параметры:**
- `token` — query param с Telegram bot token
- `text` — JSON body с HTML сообщением

**Пример:**
```bash
curl -X POST "https://bot.dev/api/send-summary?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "📚 <b>Новые идеи</b>..."}'
```

## ✨ Пример выхода

```
📚 Новые идеи от предпринимателей

Как запустить стартап за 3 месяца
Y Combinator News
Краткое описание ключевых шагов для быстрого запуска...
Читать полностью

Инвестирование в себя
Paul Graham Essays
Основатель Y Combinator объясняет почему самое важное...
Читать полностью

[и еще элементы...]
```

## 🔧 Настройка

### Добавить новый источник

Отредактируй `ENTREPRENEUR_SOURCES` в скрипте:

```python
{
    "name": "Твой источник",
    "url": "https://...",
    "type": "rss",  # или "json"
},
```

### Изменить систем-промпт

Измени `SYSTEM_PROMPT` для другого стиля суммирования.

### Фильтровать по дате

Добавь в `fetch_rss_feed()`:

```python
# Только за последние 3 дня
cutoff = datetime.now() - timedelta(days=3)
```

## 💡 Советы

1. **API Rate Limits** — не запускай чаще 1-2 раза в день (лимиты Claude API)
2. **Большие источники** — ограничивай `--limit` для скорости
3. **Сбой сети** — скрипт gracefully обрабатывает ошибки fetch
4. **Тестирование** — используй `--dry-run` перед автоматизацией

## 🐛 Отладка

Если что-то не работает:

```bash
# Посмотреть сообщение без отправки
python collect_entrepreneur_summary.py --dry-run

# Проверить подключение к worker
curl "https://your-worker.dev/api/send-summary?token=TEST" \
  -X POST -H "Content-Type: application/json" -d '{"text":"test"}'

# Проверить API key Claude
export CLAUDE_API_KEY="sk-..." && python -c "from anthropic import Anthropic; Anthropic().messages.list()"
```

---

**Готово!** Теперь Claude Code может собирать и отправлять сводки предпринимательского контента по расписанию или по требованию. 🚀
