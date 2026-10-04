import express from "express";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import pg from "pg";
import axios from "axios";

const app = express();
app.set("trust proxy", 1);
const port = 3000;

// ---------- SETTINGS (change these) ----------

const diaryPassphrase = process.env.DIARY_PASSPHRASE;
const cookieSecret = process.env.COOKIE_SECRET;
const ollamaModel = "gemma3"; // the AI model that writes the recap, questions and verse picks
const bibleTranslation = "kjv"; // "kjv" or "web" (both free, no key needed)

const db = new pg.Client({
  user: "diary",
  host: "localhost",
  database: "pen_pal_diary",
  password: process.env.DB_PASSWORD,
  port: 5432,
});
await db.connect();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser(cookieSecret));
app.use(express.static("public"));

// puts the latest verse on every page (the header shows it)
app.use(async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT reference, body FROM verses ORDER BY verse_date DESC LIMIT 1",
    );
    res.locals.verse = result.rows[0] || null;
  } catch (error) {
    console.error("Verse lookup failed:", error.message);
    res.locals.verse = null;
  }
  next();
});

// ---------- HELPERS ----------

// Shows a date like "Sun 4 Oct, 20:40". EJS can call this as when(...)
app.locals.when = (date) =>
  new Date(date).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// Backup questions, used only when the AI hasn't made a question yet
const questions = [
  "What did you eat today that you wish they'd tried?",
  "What did you see today that they would have laughed at?",
  "What's the weather doing where you are right now?",
  "Which song was stuck in your head today?",
  "What's one small thing that went wrong today?",
  "What are you looking forward to this week?",
  "Describe the room you're sitting in.",
  "Who did you talk to today, and about what?",
  "What's something you want to show them one day?",
  "What did you miss about them today?",
];

// Asks the AI for a fresh question after someone posts. Returns null if it fails or takes too long.
async function makeNextQuestion(author) {
  try {
    const recent = await db.query(
      "SELECT question FROM questions ORDER BY question_date DESC LIMIT 5",
    );
    const current = await db.query(
      "SELECT question FROM next_questions WHERE author = $1",
      [author],
    );
    const avoid = [...recent.rows, ...current.rows]
      .map((q) => q.question)
      .join("\n");

    const prompt =
      "Write ONE short, warm question (under 15 words) for someone writing a diary entry " +
      "to a loved one who lives far away. Ask about everyday life: food, weather, people, " +
      "places, or small feelings. Do not repeat or closely copy these questions:\n" +
      avoid +
      "\n\nReply with only the question.";

    const response = await axios.post(
      "http://localhost:11434/api/generate",
      { model: ollamaModel, prompt: prompt, stream: false },
      { timeout: 30000 }, // runs in the background now, so it can take longer
    );

    const question = response.data.response
      .trim()
      .split("\n")[0]
      .replace(/^["']|["']$/g, "");
    if (!question || question.length > 200) return null;
    return question;
  } catch (error) {
    console.error("Next question not made:", error.message);
    return null;
  }
}

// Runs before any page that needs you to be logged in
function checkLogin(req, res, next) {
  const name = req.signedCookies.who;
  if (!name) {
    return res.redirect("/login");
  }
  res.locals.who = name;
  next();
}

// ---------- LOGIN ----------

const loginAttempts = new Map(); // ip -> { count, resetAt }

function limitLogins(req, res, next) {
  const now = Date.now();
  const entry = loginAttempts.get(req.ip);
  if (entry && entry.resetAt > now && entry.count >= 5) {
    return res.status(429).render("login.ejs", {
      error: "Too many tries. Wait 15 minutes.",
    });
  }
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(req.ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    entry.count++;
  }
  next();
}

app.get("/login", (req, res) => {
  res.render("login.ejs", { error: "" });
});

app.post("/login", limitLogins, (req, res) => {
  const { name, pass } = req.body;

  if (!name || pass !== diaryPassphrase) {
    return res.render("login.ejs", { error: "Wrong name or passphrase." });
  }

  // remember the name for one year
  res.cookie("who", name.trim(), {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
  res.redirect("/");
});


// tiny endpoint the page polls to see if anything new was posted
app.get("/latest", checkLogin, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT COUNT(*) AS count, MAX(created_at) AS last FROM entries",
    );
    const { count, last } = result.rows[0];
    res.json({ sig: `${count}|${last ? new Date(last).toISOString() : ""}` });
  } catch (error) {
    res.status(500).json({ sig: "" });
  }
});
// ---------- DIARY PAGE ----------

app.get("/", checkLogin, async (req, res) => {
  try {
    const entries = await db.query(
      "SELECT * FROM entries ORDER BY created_at DESC",
    );

    // the newest weekly recap (or nothing if there isn't one yet)
    const recaps = await db.query(
      "SELECT * FROM recaps ORDER BY week_ending DESC LIMIT 1",
    );

    // today's question made by the AI (or nothing if there isn't one yet)
    const today = new Date().toLocaleDateString("en-CA"); // like 2026-10-04
    const todays = await db.query(
      "SELECT question FROM questions WHERE question_date = $1",
      [today],
    );

    // the question made for this person when they last posted (today only)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const next = await db.query(
      "SELECT question FROM next_questions WHERE author = $1 AND created_at >= $2",
      [res.locals.who, startOfDay],
    );

    // after a post: their fresh question. Otherwise today's AI question, then a backup
    const dayNumber = Math.floor(Date.now() / 86400000);
    const question = next.rows[0]
      ? next.rows[0].question
      : todays.rows[0]
        ? todays.rows[0].question
        : questions[dayNumber % questions.length];

    res.render("index.ejs", {
      entries: entries.rows,
      recap: recaps.rows[0] || null,
      question: question,
      error: req.query.error || "",
    });
  } catch (error) {
    console.error(error);
    res.send("Something went wrong. Check the terminal.");
  }
});

// ---------- ADD ENTRY ----------

app.post("/entries", checkLogin, async (req, res) => {
  try {
    const text = req.body.text.trim();

    if (!text) {
      return res.redirect("/?error=Write something first.");
    }

    const author = res.locals.who;

    // saved exactly as you wrote it
    await db.query("INSERT INTO entries (author, body) VALUES ($1, $2)", [
      author,
      text,
    ]);

    // put a random backup question in the box right now, so the reload is instant
    const backup = questions[Math.floor(Math.random() * questions.length)];
    await db.query(
      `INSERT INTO next_questions (author, question) VALUES ($1, $2)
       ON CONFLICT (author) DO UPDATE SET question = EXCLUDED.question, created_at = now()`,
      [author, backup],
    );

    // reload the page immediately
    res.redirect("/");

    // then let the AI write a better question in the background (nobody waits for this)
    makeNextQuestion(author).then(async (fresh) => {
      if (!fresh) return;
      try {
        await db.query(
          "UPDATE next_questions SET question = $1, created_at = now() WHERE author = $2",
          [fresh, author],
        );
      } catch (error) {
        console.error("Could not save the AI question:", error.message);
      }
    });
  } catch (error) {
    console.error(error);
    res.redirect("/");
  }
});

// ---------- WEEKLY RECAP (Saturday 9 pm) ----------

// Finds the most recent Saturday 9 pm that has already happened
function getLastSaturdayNight() {
  const date = new Date();

  // go back to the most recent Saturday
  const daysSinceSaturday = (date.getDay() + 1) % 7;
  date.setDate(date.getDate() - daysSinceSaturday);
  date.setHours(21, 0, 0, 0);

  // if that Saturday 9 pm hasn't happened yet, use the Saturday before
  if (date > new Date()) {
    date.setDate(date.getDate() - 7);
  }

  return date;
}

async function makeRecap() {
  try {
    const weekEnd = getLastSaturdayNight();
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 7);
    const weekEndingDate = weekEnd.toLocaleDateString("en-CA"); // like 2026-10-10

    // 1. Skip if this week's recap already exists
    const existing = await db.query(
      "SELECT id FROM recaps WHERE week_ending = $1",
      [weekEndingDate],
    );
    if (existing.rows.length > 0) return;

    // 2. Get this week's entries
    const result = await db.query(
      "SELECT author, body FROM entries WHERE created_at > $1 AND created_at <= $2 ORDER BY created_at",
      [weekStart, weekEnd],
    );
    if (result.rows.length === 0) return; // nobody wrote anything

    const diary = result.rows.map((e) => `${e.author}: ${e.body}`).join("\n\n");

    // 3. Ask the AI (Ollama on this computer) to write the recap
    const prompt =
      "Two people who live far apart write to each other in a shared diary. " +
      "Below are this week's entries. Write a recap of at most 120 words in plain, warm language, " +
      "addressed to both of them by name. Highlight the good moments, plans and small wins they " +
      "actually wrote about. Do not invent anything, do not give advice, and do not correct or " +
      "rewrite their words.\n\nENTRIES:\n" +
      diary;

    const response = await axios.post("http://localhost:11434/api/generate", {
      model: ollamaModel,
      prompt: prompt,
      stream: false,
    });

    // 4. Save it
    await db.query(
      "INSERT INTO recaps (week_ending, body, model) VALUES ($1, $2, $3)",
      [weekEndingDate, response.data.response.trim(), ollamaModel],
    );

    console.log(`Recap saved for the week ending ${weekEndingDate}`);
  } catch (error) {
    console.error("Recap not made yet:", error.message);
  }
}

// ---------- DAILY QUESTION (made by the AI) ----------

async function makeQuestion() {
  try {
    const today = new Date().toLocaleDateString("en-CA");

    // 1. Skip if today's question already exists
    const existing = await db.query(
      "SELECT id FROM questions WHERE question_date = $1",
      [today],
    );
    if (existing.rows.length > 0) return;

    // 2. Get the last 7 questions so the AI doesn't repeat itself
    const recent = await db.query(
      "SELECT question FROM questions ORDER BY question_date DESC LIMIT 7",
    );
    const recentList = recent.rows.map((q) => q.question).join("\n");

    // 3. Ask the AI for one new question
    const prompt =
      "Write ONE short, warm question (under 15 words) for someone writing a diary entry " +
      "to a loved one who lives far away. Ask about everyday life: food, weather, people, " +
      "places, or small feelings. Do not repeat or closely copy these recent questions:\n" +
      recentList +
      "\n\nReply with only the question.";

    const response = await axios.post("http://localhost:11434/api/generate", {
      model: ollamaModel,
      prompt: prompt,
      stream: false,
    });

    // 4. Clean it up (first line only, no quote marks)
    const question = response.data.response
      .trim()
      .split("\n")[0]
      .replace(/^["']|["']$/g, "");
    if (!question || question.length > 200) return;

    // 5. Save it
    await db.query(
      "INSERT INTO questions (question_date, question, model) VALUES ($1, $2, $3)",
      [today, question, ollamaModel],
    );

    console.log(`Question saved for ${today}: ${question}`);
  } catch (error) {
    console.error("Question not made yet:", error.message);
  }
}

// ---------- DAILY VERSE (AI picks the reference, bible-api.com supplies the text) ----------

async function makeVerse() {
  try {
    const today = new Date().toLocaleDateString("en-CA");

    // 1. Skip if today's verse already exists
    const existing = await db.query(
      "SELECT id FROM verses WHERE verse_date = $1",
      [today],
    );
    if (existing.rows.length > 0) return;

    // 2. Get the last 14 references so the AI doesn't repeat itself
    const recent = await db.query(
      "SELECT reference FROM verses ORDER BY verse_date DESC LIMIT 14",
    );
    const recentList = recent.rows.map((v) => v.reference).join("\n");

    // 3. Ask the AI to choose ONE reference (not the text)
    const prompt =
      "Choose ONE Bible verse (a single verse, not a range) that would encourage two people " +
      "who live far apart. Themes: hope, healing, love, faithfulness, comfort, strength. " +
      "Do not choose any of these recent verses:\n" +
      recentList +
      "\n\nReply with only the reference, for example Psalm 34:18 or John 3:16";

    const response = await axios.post("http://localhost:11434/api/generate", {
      model: ollamaModel,
      prompt: prompt,
      stream: false,
    });

    // 4. Keep the first line, and make sure it looks like "Book 1:1"
    const passage = response.data.response
      .trim()
      .split("\n")[0]
      .replace(/^["'“]+|["'”.]+$/g, "")
      .trim();
    if (!/\d{1,3}:\d{1,3}$/.test(passage)) {
      console.log(
        "Verse: AI reply had no usable reference:",
        response.data.response,
      );
      return;
    }

    // 5. Fetch the real text (fails if the reference doesn't exist)
    const bible = await axios.get(
      `https://bible-api.com/${encodeURIComponent(passage)}`,
      { params: { translation: bibleTranslation } },
    );
    const body = bible.data.text.trim().replace(/\s+/g, " ");
    const reference = bible.data.reference;
    if (!body) {
      console.log("Verse: Bible API returned empty text for", passage);
      return;
    }

    // 6. Save it
    await db.query(
      "INSERT INTO verses (verse_date, reference, body, model) VALUES ($1, $2, $3, $4)",
      [today, reference, body, ollamaModel],
    );

    console.log(`Verse saved for ${today}: ${reference}`);
  } catch (error) {
    console.error(
      "Verse not made yet:",
      error.message,
      error.response?.data ? JSON.stringify(error.response.data) : "",
    );
  }
}

// ---------- RUN THE BACKGROUND JOBS ----------

function runBackgroundJobs() {
  makeRecap();
  makeQuestion();
  makeVerse();
}

runBackgroundJobs(); // once at start, in case the computer was off earlier
setInterval(runBackgroundJobs, 15 * 60 * 1000); // then every 15 minutes

// ---------- START SERVER ----------

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});