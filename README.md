# LiveWalk Marketplace API

Small shared marketplace API for the first LiveWalk end-to-end booking cycle. It is a Workers-native dynamic backend published under a `webpeter.com` URL so both Android APKs can reach the same API from phones.

## API

- `GET /api/health` — health/status
- `POST /api/demo/reset` — clear demo requests/sessions/messages
- `POST /api/requests` — create a traveler walk request
- `POST /api/requests/estimate` — calculate a traveler route quote without creating a request
- `GET /api/requests?status=pending` — list guide-visible pending requests
- `GET /api/requests/:id` — traveler booking/request state
- `GET /api/bookings/:id` — booking plus session state
- `POST /api/requests/:id/accept` — guide accepts and creates a session
- `POST /api/requests/:id/decline` — guide declines
- `POST /api/sessions/:id/start` — enter live session state
- `GET /api/sessions/:id/status` — session status/messages
- `POST /api/sessions/:id/messages` — add a shared session message
- `GET /api/sessions/:id/messages` — list shared session messages
- `POST /api/sessions/:id/location` — update guide/demo location
- `POST /api/sessions/:id/media-token` — mint a short-lived (10 min), role-scoped LiveKit
  room token for an accepted session. Guides may publish camera and microphone;
  travelers may publish microphone only; both may subscribe. Requires `LIVEKIT_URL`,
  `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` runtime values.

## Verification

```bash
npm run check
npm test
```

This prototype intentionally uses a tiny edge-memory store for the live demo cycle. It is enough for the first phone-to-phone marketplace slice; production should replace it with a durable database before payments, accounts, or real availability are added.
