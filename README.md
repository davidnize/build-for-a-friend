# Between Us

*Scars leave beautiful traces.*

A small private diary for two people who used to talk face to face and now live far apart. Each of you writes entries, and you read each other's in one shared feed.

Built for the Hacktoberfest Weekend Challenge: **Build for a Friend**.

## What it does

- **Your words stay yours.** Entries are saved exactly as you type them. No AI rewrites or edits them.
- **A question of the day.** The grey placeholder in the entry box is a short question, written fresh each day by Gemma. You can answer it or write about something else.
- **"This week between us."** Every Saturday at 9 pm, Gemma reads the week's entries and writes a short recap. It is always labelled as AI-written, so it is never confused with your own words.
- **Private.** You log in with your name and a shared passphrase.
- Your entries on the right, theirs on the left.

## Built with

- Node.js and Express
- EJS templates and plain CSS
- PostgreSQL
- [Ollama](https://ollama.com) running Gemma 3 locally (open-weight AI, nothing leaves your computer)

## Run it yourself

You need Node.js, PostgreSQL and Ollama installed.

**1. Get the code and install**

```bash
npm install
```

**2. Create the database and tables**

In PostgreSQL, create a database called `pen_pal_diary` and a user called `diary`. Then run:

```sql
CREATE TABLE entries (
  id SERIAL PRIMARY KEY,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recaps (
  id SERIAL PRIMARY KEY,
  week_ending DATE NOT NULL UNIQUE,
  body TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id SERIAL PRIMARY KEY,
  question_date DATE NOT NULL UNIQUE,
  question TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**3. Change the settings**

At the top of `index.js`, set your own passphrase, cookie secret and database password:

```js
const diaryPassphrase = "change-me";
const cookieSecret = "any-long-random-text";
```

Never commit your real passwords.

**4. Get the AI model**

```bash
ollama pull gemma3
```

Keep Ollama running. The diary still works without it, but the daily question and weekly recap will not be written.

**5. Start the diary**

```bash
node index.js
```

Open http://localhost:3000.

## Folder layout

```
index.js            the server
public/main.css     the styling
views/
  index.ejs         the diary page
  login.ejs         the login page
  partials/
    header.ejs      top of every page
    footer.ejs      bottom of every page
```

## Why open-weight AI

This is a diary, so the words are private. Running Gemma on your own computer means nobody else's server ever reads them.
