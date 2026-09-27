---
status: specified
constitution: [C1, C2, C4, C5, C6, C7, C9]
---

# 020 — Inbound Media

Defines how a voice note, an image or a video a contact sends reaches the
agent, and what happens when it cannot. It leaves out sending media (that is
`012`), captions, stickers, reactions and documents.

## A media URL is a pointer the server resolves, never text the model reads

When a WhatsApp contact sends media, ManyChat stores the file in its own S3
bucket and puts the file's URL in `{{last_input_text}}`, the same variable that
carries typed text. Our callback payload and the Dynamic Block body both map
that variable to `text` (`002`), so a voice note arrives as:

```json
{
  "subscriber_id": "1000001",
  "text": "https://manybot-files.s3.eu-central-1.amazonaws.com/100000000000001/wa/2026/01/15/original_0123456789abcdef0123456789abcdef.ogg"
}
```

ManyChat sends no field saying the message was media. Observed on a real
deployment on 2026-09-27: audio arrives as `.ogg`, images as `.jpeg`, and the
URL opens without authentication and does not expire.

Today that URL passes through as if it were typed. It is validated as text,
stored as the contact's message, and handed to the model as their question. The
model answers a link. A voice note saying "I want to talk to a person" does not
match the escalation keyword it contains, and the contact is not handed off.

The obvious fix is to hand the URL to the model and let it fetch the file. That
is rejected. It leaves the URL in history, where every later turn in the 30-day
window (`018`) sends it again, and in the database, where it is a permanent,
unauthenticated link to the contact's voice or photo. It also puts what the
server fetches, and how large it is, in the model provider's hands.

So the server resolves the URL itself, before anything else reads the message.
The model receives a transcript, an image, or both for a video. The URL is
never stored and never logged.

## Media is recognised by exact host and path, in the ManyChat adapter

The ManyChat adapter treats `text` as media only when the whole trimmed value
matches:

```
https://manybot-files.s3.eu-central-1.amazonaws.com/<digits>/wa/<yyyy>/<mm>/<dd>/original_<hex>.<ext>
```

The `wa` segment is the WhatsApp channel. The extension decides the kind:

| Extension               | Kind          | Handling                            |
| ----------------------- | ------------- | ----------------------------------- |
| `.ogg`                  | `audio`       | Transcribed (below)                 |
| `.jpeg`, `.jpg`, `.png` | `image`       | Sent to the model (below)           |
| `.mp4`, `.3gp`          | `video`       | Frames and soundtrack, both (below) |
| anything else           | `unsupported` | Fallback, never downloaded          |

Only `.ogg` and `.jpeg` have been observed. The other extensions come from the
formats WhatsApp accepts (ManyChat's media guidelines, updated 2026-08-24), and
are listed so a `.png` or `.mp4` is not mistaken for text.

A match sets `media: { kind, url }` on `InboundMessage`, which stays
channel-neutral: nothing past the adapter knows what a ManyChat URL looks like.
A URL a contact types inside a sentence is not the whole value, so it stays
text. So does a URL on any other host, or over plain HTTP.

The download is the ManyChat HTTP boundary (`004`). It fetches only that host,
over HTTPS, does not follow redirects, and requires a `Content-Type` that
matches the kind (`audio/*`, `video/*` or `image/*`).

## A voice note or a video is transcribed, then treated exactly like typed text

The transcript replaces `text`, and from there the turn is the one a typed
message would get:

- escalation keywords match against it, so a spoken "I want to talk to a
  person" hands off;
- it is fenced as untrusted contact input (C4);
- it is recorded as the contact's message, and enters history and the turn
  cap exactly as a typed message would (`019` § Only bound turns enter history
  and the turn cap).

The runner is told the message was a transcript, so the prompt can tell the
model that a name or a number in it may have been misheard, and to confirm
rather than assume.

An empty transcript, from a voice note with nothing said, is not a failure. The
contact sent something the agent cannot read, so it takes the fallback below.

The opening trigger (`001`) never matches a transcript. That sentinel is sent by
the tenant's flow, not spoken by a contact.

Transcription uses `TRANSCRIPTION_MODEL`, in the same `provider:model` form as
`AGENT_MODEL`, and resolved only in `registry.ts` (C2). It is a second model,
not a setting on the first: not every answering model takes audio, and voice
support should not depend on which model answers. When
`TRANSCRIPTION_MODEL` is unset, voice notes take the fallback. That keeps
`pnpm dev` working with no key.

Transcription cost is recorded as spend and counts against the daily budget.
Its pricing sits in the registry beside token pricing, and an unknown model
falls back to a pessimistic estimate, as `pricingFor` already does.

## An image goes to the model once, as bytes, and history keeps only a marker

The server downloads the image and passes the model the bytes, not the URL.
Every provider the registry supports accepts images, but some only fetch their
own URLs, and passing bytes keeps the host check and size limit in our hands.

The contact's message is recorded as the marker `[image]`, with
`media_kind = 'image'`. Later turns see the marker, not the image. Sending the
image again on every turn for 30 days would pay for it every time, and nothing
later needs it: the agent's reply to it is in history too.

What an image shows is never evidence of a fact the catalog does not hold. A
screenshot of a price, an old advertisement or a payment receipt does not set a
price, confirm a date or prove a payment (`001` § Grounding rule, C6). Text
inside an image is contact input like any other, and the prompt says so (C4).
Unlike typed text it cannot be fenced, which is why the prompt has to say it.

Whether the answering model accepts images is a registry capability, keyed on
the `provider:model` string like `supportsTemperature`. A model that does not
accept them, such as a local model without vision (`007`), sends images to the
fallback.

## A video is read as still frames and a transcript of its soundtrack

A contact who films a nail design and asks "can I learn this?" needs the model
to see the design and hear the question. The soundtrack alone loses the first;
the frames alone lose the second. So a video is split into both, and each goes
where the same content would go if the contact had sent it separately:

- **Frames** go to the answering model as images, under every rule of the image
  section above, including that nothing in them is evidence of a catalog fact.
- **The soundtrack** goes to `TRANSCRIPTION_MODEL`, and its transcript is
  treated like a voice note's: keywords, fencing, history and the turn cap.

The answering model does not receive the video file itself. Only one of the
registry's providers accepts video, so sending it whole would tie video support
to one provider. Frames work with any model that accepts images.

The split is done by ffmpeg, installed in the runtime image from Alpine's
package repository, where the image already gets `tini`. It reads from the
downloaded bytes, never from a URL, with network protocols disabled
(`-protocol_whitelist pipe`), and is killed by the turn's abort signal. The
file is untrusted input to a media parser, so nothing is passed to it but the
bytes and fixed arguments.

It takes at most 4 frames, evenly spaced across the video, each scaled so its
longest side is at most 768 pixels. Neither number was measured. They hold a
video's cost near that of four images, whatever its length, and are revisited
with a dated measurement from devtest before this spec is marked implemented.

Each half degrades on its own. The runner is told which halves it received, so
the model never claims to have seen or heard what it was not given:

| Answering model accepts images | `TRANSCRIPTION_MODEL` set | The model receives    |
| ------------------------------ | ------------------------- | --------------------- |
| yes                            | yes                       | frames and transcript |
| yes                            | no                        | frames only           |
| no                             | yes                       | transcript only       |
| no                             | no                        | nothing: fallback     |

A silent video is not a failure: the model gets the frames, and it takes the
fallback only when there are no frames either. A server without ffmpeg sends
every video to the fallback, and logs that once at boot, the way an unset
`TRANSCRIPTION_MODEL` is a deliberate state rather than an error.

The contact's message is recorded as the transcript with `media_kind = 'video'`,
or as `[video]` when there is none. Frames are never stored, and later turns do
not see them, for the same reason an image is sent once.

## Media the agent cannot read gets the tenant's "please type it" reply

The fallback reply is `rules.messages.mediaFallback`: tenant copy, not source
(C9). The model does not run. The contact's message is recorded as a marker for
its kind (`[voice note]`, `[video]`, `[image]` or `[media]`), and the turn is
recorded with a new outcome, `media_fallback`, so these turns can be told apart
from answers and handoffs.

`mediaFallback` is optional, so no existing `rules.json` fails to load. Without
it, the turn escalates with `rules.messages.escalation` and is recorded as
`escalated_precheck`. A contact who cannot be asked to type is handed to a
person (C6).

## A failure we caused hands off; a format we don't support asks the contact to type

| What happened                                                  | Result              |
| -------------------------------------------------------------- | ------------------- |
| Unrecognised extension                                         | Fallback            |
| Voice note with no `TRANSCRIPTION_MODEL`, or empty transcript  | Fallback            |
| Image when the answering model does not accept images          | Fallback            |
| Video with neither frames nor transcript available (see above) | Fallback            |
| Server has no ffmpeg (video only)                              | Fallback            |
| Download fails, wrong `Content-Type`, redirect                 | Escalation, `error` |
| File over the size limit                                       | Escalation, `error` |
| Transcription fails                                            | Escalation, `error` |
| ffmpeg fails on a video                                        | Escalation, `error` |

The fallback asks the contact to do something they can do: type the question.
A failed download, transcription or frame extraction is not something the
contact can fix, and asking them to type would blame them for our failure.
Those hand off (C6).

The size limits are WhatsApp's own: 5 MB for an image and 16 MB for audio or
video (ManyChat's media guidelines, updated 2026-08-24). A file over them
should not exist, so exceeding one means the platform has changed. That is an
anomaly to escalate, not a contact to redirect. The limit is enforced while
reading the body, not trusted from `Content-Length`.

## Download and transcription run inside the race

Today the pre-model guards run before the race, and the deadline starts just
before the model call. A voice note or video cannot work that way, because the
keyword check needs the transcript.

For a media turn, the order is:

1. Rate limit, turn cap and budget: these need no text, so a contact who is
   already over a limit costs no download.
2. The deadline starts.
3. Download; for a video, frame and soundtrack extraction; then transcription.
4. Escalation keywords, now on the transcript.
5. The model.

Steps 3 to 5 share the existing 8-second deadline and the existing model abort
signal (`002` § Latency budget, C7). If the deadline passes during any of them,
the contact gets the acknowledgement and the rest completes into the outbox, as
a slow model call already does. That includes an escalation the transcript
produces. No new timeout is introduced: the abort signal that bounds a runaway
model call also bounds a runaway download.

A text turn is unchanged.

## The URL never reaches storage or logs

`messages` stores the transcript or the marker, never the URL, and gains a
nullable `media_kind` column (`audio`, `image`, `video`, `unsupported`), so a
transcript can be told apart from typed text.

The logger redacts the media URL shape wherever it appears, rather than relying
on each call site to leave it out (C5). The redaction test gains an invented
example.

A `text` that contains the media host but does not match the exact shape is
logged as `media_url_unmatched`, with the URL redacted. It is the only signal
that ManyChat changed its URL format, which would otherwise turn every voice
note back into a link the model answers.

Fixtures and tests use invented account IDs, dates and hashes, like the example
above. A real media URL carries the tenant's ManyChat account ID and opens the
contact's file for good (C1, C5).

## Verification

1. **Adapter unit tests** cite § Media is recognised by exact host and path.
   Each extension maps to its kind. A URL inside a sentence, on another host,
   over HTTP, or with a malformed path stays text.
2. **An integration test** (PGlite, mock model, fake fetch at the ManyChat
   boundary, mock transcriber at the model boundary) sends a voice note. It
   asserts the runner receives the fenced transcript, the `messages` row holds
   the transcript with `media_kind = 'audio'`, and no row or log line contains
   the URL.
3. **A keyword test** asserts a transcript containing an escalation keyword
   escalates.
4. **An image test** asserts the runner receives image bytes, the row holds
   `[image]`, and the next turn's history contains the marker and no image.
5. **Video tests**, one per row of the degradation table, run ffmpeg on a
   small invented clip committed as a fixture. Each asserts which of frames and
   transcript the runner receives, that it is told which it received, that at
   most 4 frames arrive, and that the row holds the transcript or `[video]` with
   `media_kind = 'video'`. A clip with no audio track still reaches the model
   as frames.
6. **Fallback tests** assert an unrecognised extension makes no fetch, and that
   it, an empty voice-note transcript, an unset `TRANSCRIPTION_MODEL` and a
   missing ffmpeg each reply with `mediaFallback` and record `media_fallback`.
   Without `mediaFallback`, the turn escalates.
7. **Failure tests**: a 500 from the fetch, a redirect, a wrong
   `Content-Type`, an oversized body, a throwing transcriber and a corrupt
   video ffmpeg rejects each produce an escalation with outcome `error`.
8. **A race test**: a transcriber slower than the deadline produces the
   acknowledgement, and the reply lands in the outbox.
9. **The redaction test** asserts an invented media URL is scrubbed.
10. **C2** is enforced by the existing lint rule: the transcription provider
    is imported only in `registry.ts`.

What this misses:

- **The URL shape can change.** Every test uses the shape observed on
  2026-09-27. If ManyChat changes it, the tests still pass and media turns back
  into text. `media_url_unmatched` in the logs is the only warning.
- **The route is unverified.** ManyChat documents `external_message_callback`
  as firing on "text messages". Media was observed arriving, but which route
  delivered it — the callback, or the Dynamic Block after ManyChat's default
  reply — was not recorded. If only one route carries media, a contact on the
  other gets no reply at all, and nothing here detects it.
- **No test proves a transcript is right.** The mock transcriber returns what
  the test gives it. Transcription quality in the tenant's language is checked
  by listening, not by the suite.
- **No real WhatsApp video has been observed.** Only `.ogg` and `.jpeg` URLs
  were seen. The video tests prove ffmpeg handles the committed clip, not that
  WhatsApp's `.mp4` or `.3gp` files split the same way.
- **Four frames can miss what matters.** A detail shown for a moment between
  two sampled frames never reaches the model, and no test can tell.
- **Captions are lost before they reach us.** An image with a caption arrives
  as the URL alone, per a community report from January 2026. Nothing here
  recovers the caption.
- **Stickers and reactions are invisible.** Reports say ManyChat repeats the
  contact's previous text for them. A repeated message cannot be told apart
  from a contact asking again, so it gets answered again.
