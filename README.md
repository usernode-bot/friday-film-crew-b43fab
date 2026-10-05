# Friday Film Crew

A movie-night poll: everyone in the group suggests films for Friday, votes
for the one they want (one vote each, switchable until the group sits down),
and the marquee banner at the top shows whatever is currently winning.

## How it works

- **Suggest** — anyone in the group adds a film with a title (required) and
  an optional note on why it is worth watching. Suggesting a film that is
  already on the list is declined with a friendly "already suggested"
  message rather than adding a duplicate.
- **Vote** — one vote per person. Voting for another film moves your vote;
  it can be switched but not taken back. There is no closing mechanism: the
  winner is simply the film with the most votes (a tie goes to the film
  suggested first) whenever the group sits down on Friday.
- **The marquee** — the banner at the top shows the current leader and its
  vote count, or "No one is winning yet". It refreshes after every
  suggestion or vote and every 30 seconds.

Visitors without a Homeroom account can look at the poll read-only;
suggesting and voting ask them to make an account (the platform's standard
behaviour).

## Under the hood

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app already knows who is using it.
  No accounts to build.
- **Database** — the app's own private Postgres database holds two
  append-only tables: `films` (title, optional note, who added it, with a
  unique index on `lower(title)` so duplicates are impossible) and `votes`
  (one row per voter, `UNIQUE (voter_id)`, moved by an upsert when someone
  switches their vote).
- **API** — `GET /api/films` (public read, ranked by votes), `POST /api/films`
  (suggest, needs an account) and `POST /api/votes` (vote, needs an account).
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The palette is a marquee-amber accent on warm grey neutrals; see
  `CLAUDE.md` for the design notes.

On staging previews the poll is seeded with obviously fake "Staging demo:"
films and votes from fake users, so the populated screen can be seen.
