#!/usr/bin/env python3
"""
Collect entrepreneur content summaries and send to Telegram via bot API.
Usage: python collect_entrepreneur_summary.py [--worker-url <url>] [--token <token>]
"""

import os
import sys
import json
import argparse
import feedparser
import requests
from datetime import datetime, timedelta
from anthropic import Anthropic

# Configuration
ENTREPRENEUR_SOURCES = [
    {
        "name": "Y Combinator News",
        "url": "https://news.ycombinator.com/rss",
        "type": "rss",
    },
    {
        "name": "Paul Graham Essays",
        "url": "http://www.aaronsw.com/2002/feeds/pgessays.xml",
        "type": "rss",
    },
    {
        "name": "Indie Hackers",
        "url": "https://www.indiehackers.com/feed.xml",
        "type": "rss",
    },
    {
        "name": "Sam Altman Blog",
        "url": "https://blog.samaltman.com/feed",
        "type": "rss",
    },
    {
        "name": "Dev.to",
        "url": "https://dev.to/api/articles?tag=startup&per_page=10",
        "type": "json",
    },
]

SYSTEM_PROMPT = """Ты эксперт по анализу предпринимательского контента.
Твоя задача - создавать краткие, actionable саммари статей для предпринимателя.
Форматирование: HTML для Telegram (<b>жирный</b>, <i>курсив</i>, <code>код</code>).
Фокусируйся на практичных идеях и уроках, которые можно применить в бизнесе.
Саммари должно быть 2-3 предложения максимум."""


def fetch_rss_feed(url: str, limit: int = 5) -> list[dict]:
    """Fetch and parse RSS feed."""
    try:
        feed = feedparser.parse(url)
        items = []
        for entry in feed.entries[:limit]:
            items.append(
                {
                    "title": entry.get("title", ""),
                    "link": entry.get("link", ""),
                    "summary": entry.get("summary", "")[:500],
                    "published": entry.get("published", ""),
                }
            )
        return items
    except Exception as e:
        print(f"Error fetching RSS from {url}: {e}")
        return []


def fetch_devto(url: str, limit: int = 5) -> list[dict]:
    """Fetch articles from Dev.to API."""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        articles = response.json()
        items = []
        for article in articles[:limit]:
            items.append(
                {
                    "title": article.get("title", ""),
                    "link": article.get("url", ""),
                    "summary": article.get("description", "")[:500],
                    "published": article.get("published_at", ""),
                }
            )
        return items
    except Exception as e:
        print(f"Error fetching Dev.to: {e}")
        return []


def fetch_content_items(sources: list[dict], limit: int = 5) -> list[dict]:
    """Fetch content from all configured sources."""
    all_items = []

    for source in sources:
        print(f"Fetching from {source['name']}...")
        if source["type"] == "rss":
            items = fetch_rss_feed(source["url"], limit)
        elif source["type"] == "json":
            items = fetch_devto(source["url"], limit)
        else:
            continue

        for item in items:
            all_items.append(
                {
                    "source": source["name"],
                    "title": item.get("title", ""),
                    "url": item.get("link", ""),
                    "summary": item.get("summary", ""),
                }
            )

    return all_items[:10]  # Limit total items


def escape_html(text: str) -> str:
    """Escape HTML special characters."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def summarize_content(client: Anthropic, title: str, content: str) -> str:
    """Summarize content using Claude."""
    try:
        message = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=300,
            system=SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": f"Суммируй эту статью для предпринимателя:\n\nЗаголовок: {title}\n\nСодержание:\n{content}",
                }
            ],
        )
        return message.content[0].text
    except Exception as e:
        print(f"Error summarizing content: {e}")
        return content[:200]


def send_to_telegram(
    worker_url: str, token: str, message: str
) -> bool:
    """Send message to Telegram via bot worker API."""
    try:
        response = requests.post(
            f"{worker_url}/api/send-summary",
            params={"token": token},
            json={"text": message},
            timeout=10,
        )
        response.raise_for_status()
        print("✅ Message sent to Telegram successfully")
        return True
    except Exception as e:
        print(f"❌ Error sending to Telegram: {e}")
        return False


def create_summary_message(summaries: list[dict]) -> str:
    """Create formatted HTML message for Telegram."""
    lines = ["📚 <b>Новые идеи от предпринимателей</b>", ""]

    for item in summaries:
        lines.append(f"<b>{escape_html(item['title'])}</b>")
        lines.append(f"<i>{escape_html(item['source'])}</i>")
        lines.append(escape_html(item["summary"]))

        # Add link if available
        if item.get("url"):
            lines.append(f'<a href="{escape_html(item["url"])}">Читать полностью</a>')

        lines.append("")

    message = "\n".join(lines)
    # Telegram has 4096 char limit
    return message[:4096]


def main():
    parser = argparse.ArgumentParser(
        description="Collect and summarize entrepreneur content"
    )
    parser.add_argument(
        "--worker-url",
        default=os.getenv("WORKER_URL", "http://localhost:8787"),
        help="Worker URL (default: $WORKER_URL or localhost:8787)",
    )
    parser.add_argument(
        "--token",
        default=os.getenv("TG_TOKEN"),
        help="Telegram bot token (default: $TG_TOKEN)",
    )
    parser.add_argument(
        "--claude-key",
        default=os.getenv("CLAUDE_API_KEY"),
        help="Claude API key (default: $CLAUDE_API_KEY)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Max items per source (default: 5)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print message without sending to Telegram",
    )

    args = parser.parse_args()

    # Validate required arguments
    if not args.claude_key:
        print("❌ Error: CLAUDE_API_KEY not set")
        sys.exit(1)

    if not args.token and not args.dry_run:
        print("❌ Error: TG_TOKEN not set")
        sys.exit(1)

    print("🔍 Collecting entrepreneur content...")
    items = fetch_content_items(ENTREPRENEUR_SOURCES, limit=args.limit)

    if not items:
        print("⚠️  No content found")
        return

    print(f"📖 Found {len(items)} items, summarizing...")

    # Initialize Anthropic client
    client = Anthropic(api_key=args.claude_key)

    # Summarize each item
    summaries = []
    for i, item in enumerate(items, 1):
        print(f"  [{i}/{len(items)}] {item['title'][:50]}...")
        summary = summarize_content(client, item["title"], item["summary"])
        summaries.append(
            {
                "title": item["title"],
                "source": item["source"],
                "summary": summary,
                "url": item["url"],
            }
        )

    # Create and send message
    message = create_summary_message(summaries)

    print(f"\n{'=' * 60}")
    print("📨 Message preview:")
    print(message)
    print(f"{'=' * 60}\n")

    if args.dry_run:
        print("✅ Dry run complete (message not sent)")
    else:
        if send_to_telegram(args.worker_url, args.token, message):
            print("✅ Done!")
        else:
            sys.exit(1)


if __name__ == "__main__":
    main()
