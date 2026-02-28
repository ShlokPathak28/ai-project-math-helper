# Math Solver AI (Groq Vision)

A local, single-page math tutoring app with:
- A custom Node.js HTTP server (`server.js`)
- A rich browser UI (`math-solver.html`)
- Groq Chat Completions as the LLM backend
- Vision-model image solving (no OCR pipeline)

The app can solve typed or image-based math problems, render structured step-by-step solutions, and support follow-up chat in multiple teaching styles.

## Features

- Three explanation personas:
  - `Teacher` (formal + rigorous)
  - `Friend` (casual + fun)
  - `Parent` (warm + patient)
- Three detail levels:
  - `brief` (2-3 steps)
  - `standard` (4-6 steps)
  - `deep` (8-12+ steps)
- Image upload + drag/drop + clipboard paste
- Image upload solved directly by vision-capable models
- Groq model discovery (`/api/models`) with hardcoded fallback model list
- Follow-up chat per problem
- Clickable steps for "deep explain" expansion
- Local fast-path solver for simple arithmetic expressions (no model call needed)
- Request-size limits and structured error responses

## Tech Stack

- Node.js (CommonJS)
- Built-in `http` and `https` modules (no Express)
- Plain HTML/CSS/JS frontend (single file)

## Project Structure

```text
.
|- server.js            # Backend server + Groq proxy + static serving
|- math-solver.html     # Full frontend UI and client logic
|- package.json
|- .env                 # Local env vars (not for commit)
|- README.md
```

## Prerequisites

- Node.js 18+ recommended
- A Groq API key

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create/update `.env` in project root:
```env
GROQ_API_KEY=your_groq_api_key_here
PORT=3000
```

3. Start server:
```bash
npm start
```

Or for debugging:
```bash
npm run dev
npm run debug
```

4. Open:
```text
http://localhost:3000
```

## Environment Variables

- `GROQ_API_KEY` (required for LLM features)
- `PORT` (optional, default `3000`)

If `GROQ_API_KEY` is missing:
- `/api/models` still returns fallback models so UI remains usable
- `/api/chat` returns an auth/config error until the key is set

## API Reference

All endpoints return JSON and set CORS header `Access-Control-Allow-Origin: *`.

### `GET /health`

Health and runtime info.

Example response:
```json
{
  "ok": true,
  "uptimeSec": 123,
  "apiKey": "set"
}
```

### `GET /api/models`

Fetches available models from Groq (`/openai/v1/models`), filters to chat-capable entries, and falls back to a hardcoded list on error.

Example response:
```json
{
  "models": [
    { "name": "llama-3.3-70b-versatile" },
    { "name": "llama-3.1-8b-instant" }
  ]
}
```

### `POST /api/chat`

Proxy to Groq Chat Completions (`/openai/v1/chat/completions`).

Request body:
```json
{
  "model": "llama-3.3-70b-versatile",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

Response:
```json
{
  "text": "Model response text..."
}
```

Notes:
- Client may send an `images` array in a message; backend forwards multimodal blocks to Groq.
- Max request body size: `20,000,000` bytes.

## Frontend Behavior

`math-solver.html` includes all UI and client logic:

- Mode-specific prompts enforce strict output format labels
- Format validator + automatic reformat pass if model output is off-format
- Sanity checks compare answer consistency and basic arithmetic correctness when possible
- Recovery path converts malformed model output into displayable structured lines
- History stores up to 10 problem sessions
- Follow-up chat ties to selected history entry
- Theme toggle (light/dark) and responsive sidebar behavior

## Solving Pipeline

When user clicks **Solve**:

1. Build problem text using priority:
   - typed input
   - fallback image description prompt
2. Build system prompt from selected mode + detail level + notation rules.
3. If simple arithmetic and no image/follow-up, compute locally (`buildLocalSolution`).
4. Otherwise call `/api/chat`.
5. If output format is invalid, request strict reformat from model.
6. Parse + validate; if unusable, coerce to a fallback structure.
7. Render solution, update history, and append chat messages.

## Error Handling and Limits

- Body-size guard with `413` responses for oversized payloads
- Unknown `/api/*` routes return structured `404`
- Server logs per request include method, path, status, and duration
- Handles uncaught exceptions and unhandled promise rejections with fatal logs
- Protects static file serving against path traversal

## Security Notes

- Do not commit `.env` with real API keys
- CORS is currently open (`*`) for local/dev convenience
- Static serving is restricted to project root via resolved-path checks

## Development Notes

- This project currently has no test suite configured.
- The frontend is a single large HTML file with inline CSS/JS for simplicity.
- Backend intentionally avoids additional frameworks and uses native Node modules.

## Quick Troubleshooting

- `! Set GROQ_API_KEY and restart server` in UI:
  - ensure `.env` contains a valid `GROQ_API_KEY`
- Port already in use:
  - change `PORT` in `.env`, or free the existing process
- Image not solving:
  - ensure a vision-capable model is selected (for example, Maverick/Scout)

## License

ISC (per `package.json`).
