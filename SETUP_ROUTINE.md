# Настройка Routine в Claude Code

Автоматическая отправка сводок предпринимательского контента каждое утро через MyLife connector.

## 📋 Что нужно

1. **Python** с установленными зависимостями:
   ```bash
   pip install anthropic feedparser requests
   ```

2. **Переменные окружения** (в Claude Code settings):
   - `CLAUDE_API_KEY` — твой Claude API key
   - `TG_TOKEN` — токен Telegram бота (или пусто, если использовать через коннектор)
   - `WORKER_URL` — URL твоего Cloudflare Worker (например: `https://tasktracker.yourdomain.com`)

3. **MyLife MCP connector** — уже настроен в Claude Code

## 🚀 Настройка Routine

### Способ 1: Через Claude Code Web Interface

1. Открой **Claude Code** → **Settings** → **Routines**
2. Нажми **"Create new routine"**
3. Заполни:
   - **Name**: `Daily Entrepreneur Summary`
   - **Description**: `Собирает и отправляет сводку контента предпринимателей`
   - **Schedule**: `0 9 * * *` (9:00 AM по МСК, или выбери своё время)
   - **Command**: 
   ```bash
   python collect_entrepreneur_summary.py --worker-url $WORKER_URL --token $TG_TOKEN --claude-key $CLAUDE_API_KEY
   ```

4. **Сохрани**

### Способ 2: Через `.claude/hooks.json`

Добавь в `.claude/hooks.json`:

```json
{
  "routines": [
    {
      "name": "daily-entrepreneur-summary",
      "schedule": "0 9 * * *",
      "description": "Собирает и отправляет сводку контента предпринимателей",
      "run": "cd /path/to/mybrand-smm && python collect_entrepreneur_summary.py --worker-url $WORKER_URL --token $TG_TOKEN --claude-key $CLAUDE_API_KEY"
    }
  ]
}
```

## ⏰ Расписание (Cron формат)

Примеры:
- `0 9 * * *` — 09:00 каждый день (по UTC; 12:00 МСК)
- `0 7 * * *` — 07:00 каждый день (по UTC; 10:00 МСК)
- `0 6 * * *` — 06:00 каждый день (по UTC; 09:00 МСК)
- `0 9 * * 1-5` — 09:00 по будням (Пн-Пт)

[Калькулятор cron](https://crontab.guru/)

## 🔐 Переменные окружения

### Вариант 1: Глобальные (в Claude Code Settings)

1. Открой **Settings** → **Environment Variables**
2. Добавь:
   ```
   CLAUDE_API_KEY=sk-...
   TG_TOKEN=123456:ABC...
   WORKER_URL=https://tasktracker.yourdomain.com
   ```

### Вариант 2: В `.claude/settings.json`

```json
{
  "env": {
    "CLAUDE_API_KEY": "sk-...",
    "TG_TOKEN": "123456:ABC...",
    "WORKER_URL": "https://tasktracker.yourdomain.com"
  }
}
```

## 🧪 Тестирование

Перед созданием Routine протестируй:

```bash
# Посмотреть сообщение без отправки
python collect_entrepreneur_summary.py --dry-run

# Отправить реальное сообщение
python collect_entrepreneur_summary.py \
  --worker-url "https://tasktracker.yourdomain.com" \
  --token "123456:ABC..." \
  --claude-key "sk-..."
```

## 📊 Как это работает

```
Claude Code Routine (9:00 AM)
    ↓
collect_entrepreneur_summary.py
    ↓
[Fetch RSS] → [Summarize with Claude] → [Format HTML]
    ↓
/api/send-summary (Cloudflare Worker)
    ↓
MyLife MCP Connector
    ↓
Telegram Bot → Твой чат
```

## 🔧 Опции скрипта

```bash
python collect_entrepreneur_summary.py \
  --worker-url "https://bot.dev"      # URL твоего Worker
  --token "TG_TOKEN"                   # Telegram bot token
  --claude-key "sk-..."                # Claude API key
  --limit 5                            # Max items per source
  --dry-run                            # Preview only
```

## 🎯 Источники контента

Скрипт собирает из:
- Y Combinator News
- Paul Graham Essays
- Indie Hackers
- Sam Altman Blog
- Dev.to (startup articles)

Легко добавить свои источники в `ENTREPRENEUR_SOURCES` переменную в скрипте.

## ❓ Troubleshooting

### "Command not found: python"
```bash
# Используй полный путь
/usr/bin/python3 collect_entrepreneur_summary.py
```

### "ModuleNotFoundError: No module named 'anthropic'"
```bash
pip install anthropic feedparser requests
```

### "Error sending via MyLife API"
- Проверь что `WORKER_URL` правильный
- Проверь что `TG_TOKEN` валидный
- Проверь сетевое подключение

### "No content found"
- Проверь что RSS feeds доступны (нет блокировок)
- Попробуй с `--dry-run` чтобы увидеть логи

## 📝 Дополнительно

Полная документация: смотри `ENTREPRENEUR_SUMMARY.md`

---

**После настройки:** Routine будет каждый день автоматически собирать и отправлять сводку в твой Telegram через MyLife connector! 🚀
