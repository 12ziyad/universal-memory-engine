/**
 * A2B — ONE canonical secret/security corpus (campaign 2026-08-07).
 *
 * Every scrubber in the stack — the server's shared lane (src/pipeline/scrub.js),
 * the Claude capture hook, and the Codex capture hook — is tested against THIS
 * file, so a class one implementation knows and another lacks (the SEC-01 drift)
 * cannot recur silently. Runtime code does not have to be shared; the corpus is.
 *
 * Entry contract:
 *   text          — realistic input as a user would paste it
 *   mustNotSurvive — canary values that must be absent after scrubbing
 *   mustSurvive    — context that must remain (anti-over-redaction)
 *   expect         — per-scrubber obligation: "must" | { exempt: "<documented reason>" }
 *
 * An exemption is a VISIBLE documented limitation, never a silent skip. Adding
 * an exemption requires a defect-ledger or decision-log reference.
 */

export const SECRET_ENTRIES = [
	{
		id: "prose-password",
		class: "labeled prose",
		text: "Quick context: my password is Kite7$lantern for the staging box, please never store it.",
		mustNotSurvive: ["Kite7$lantern"],
		mustSurvive: ["password", "staging box"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "env-line",
		class: ".env assignment",
		text: "Here is my .env if it helps:\nDB_PASSWORD=Vault3#marrow\nDB_HOST=db.internal",
		mustNotSurvive: ["Vault3#marrow"],
		mustSurvive: ["DB_HOST", "db.internal"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "shell-export",
		class: "shell assignment",
		text: "I run export PGPASSWORD='Quay8!ember' before the migration script.",
		mustNotSurvive: ["Quay8!ember"],
		mustSurvive: ["migration script"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "json-config",
		class: "JSON config",
		text: 'My config file reads {"apiKey": "ak_fake_9Q2vXr7LmP4w", "region": "weur"} right now.',
		mustNotSurvive: ["ak_fake_9Q2vXr7LmP4w"],
		mustSurvive: ["region", "weur"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "yaml-config",
		class: "YAML config",
		text: "The deploy yaml has:\n  admin_token: Yml6-fake-7Tq2Wz\n  replicas: 3",
		mustNotSurvive: ["Yml6-fake-7Tq2Wz"],
		mustSurvive: ["replicas"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "authorization-header",
		class: "HTTP header",
		text: "The failing request sends Authorization: Bearer brr_fake_6Yw3Km8Zt1v4Nc7Xp2Qd5Lf8Hj3Gm6 and still 401s.",
		mustNotSurvive: ["brr_fake_6Yw3Km8Zt1v4Nc7Xp2Qd5Lf8Hj3Gm6"],
		mustSurvive: ["Authorization", "401"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "jwt",
		class: "JWT",
		text: "The session JWT is eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoxLCJjYW1wYWlnbiI6dHJ1ZX0.c2lnbmF0dXJlLWZha2UtZm9yLXRlc3Q and it expires hourly.",
		mustNotSurvive: ["eyJmYWtlIjoxLCJjYW1wYWlnbiI6dHJ1ZX0"],
		mustSurvive: ["expires hourly"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "aws-access-key",
		class: "cloud key prefix (correctly shaped, 20 chars)",
		text: "The old deploy user was AKIAIOSFODNN7EXAMPLE before we rotated it.",
		mustNotSurvive: ["AKIAIOSFODNN7EXAMPLE"],
		mustSurvive: ["rotated"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "aws-temporary-key",
		class: "cloud key prefix — STS/temporary credentials (SEC-03)",
		text: "The assumed-role session used ASIAY34FZKBOKMUTVV7A before it expired.",
		mustNotSurvive: ["ASIAY34FZKBOKMUTVV7A"],
		mustSurvive: ["assumed-role", "expired"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "aws-key-overlong",
		class: "cloud key prefix — length-brittle boundary (SEC-03)",
		// A prefix family must not be defeated by trailing characters: a
		// paste that runs long (or concatenates) is still the credential.
		text: "Someone pasted AKIAIOSFODNN7EXAMPLEKEYQ into the ticket.",
		mustNotSurvive: ["AKIAIOSFODNN7EXAMPLEKEYQ"],
		mustSurvive: ["ticket"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "anthropic-style-key",
		class: "vendor key prefix",
		text: "I pasted sk-ant-api03-fake7Vv2mQ9xLp4Rw8Tz1Yc6Nb3 into the wrong box earlier.",
		mustNotSurvive: ["sk-ant-api03-fake7Vv2mQ9xLp4Rw8Tz1Yc6Nb3"],
		mustSurvive: ["wrong box"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "db-url",
		class: "connection URL credentials",
		text: "Connection string: postgres://itsuki:N0va9pass@db.internal:5432/memory — the host part is right.",
		mustNotSurvive: ["N0va9pass"],
		mustSurvive: ["db.internal", "5432"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "query-string-secret",
		class: "query-string credential",
		text: "It calls https://api.example.com/v1/pull?api_key=qs_fake_8Rt2Lw9Xv4 on every poll.",
		mustNotSurvive: ["qs_fake_8Rt2Lw9Xv4"],
		mustSurvive: ["api.example.com"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "private-key-block",
		class: "PEM block",
		text: "-----BEGIN PRIVATE KEY-----\nMIIEvFAKEKEYMATERIALq7w8e9r0t1y2u3i4o5p6\nZmFrZS1rZXktbGluZS10d28tZm9yLXRlc3Q\n-----END PRIVATE KEY-----\nThat is the cert the loadbalancer rejected.",
		mustNotSurvive: ["MIIEvFAKEKEYMATERIALq7w8e9r0t1y2u3i4o5p6"],
		mustSurvive: ["loadbalancer"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "code-block-secret",
		class: "secret inside code block",
		text: "```js\nconst client = connect({ secret: \"cb_fake_5Xp4Jn2Qd7\" });\n```\nThat is the initializer we ship.",
		mustNotSurvive: ["cb_fake_5Xp4Jn2Qd7"],
		mustSurvive: ["initializer"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "tool-log-secret",
		class: "secret inside tool output",
		text: "[tool] curl -H 'x-api-key: tl_fake_3Fz6Vb9Sm2' https://internal.example — exited 0",
		mustNotSurvive: ["tl_fake_3Fz6Vb9Sm2"],
		mustSurvive: ["exited 0"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "quoted-passphrase",
		class: "quoted multi-word passphrase",
		text: 'For the wiki login my password is "correct horse battery staple" as of today.',
		mustNotSurvive: ["correct horse battery staple"],
		mustSurvive: ["wiki login", "as of today"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
	{
		id: "credential-label",
		class: "credential label",
		text: "The rotation script sets credential: Adm1n-rotate-77 until Friday.",
		mustNotSurvive: ["Adm1n-rotate-77"],
		mustSurvive: ["rotation script", "Friday"],
		expect: { server: "must", claude: "must", codex: "must" },
	},
];

export const FALSE_POSITIVE_ENTRIES = [
	{
		id: "password-manager-mention",
		text: "My password is stored in 1Password, so I never type it.",
		mustSurvive: ["1Password", "never type it"],
	},
	{
		id: "password-policy-talk",
		text: "The password policy requires rotation every 90 days and a minimum of 12 characters.",
		mustSurvive: ["rotation every 90 days", "12 characters"],
	},
	{
		id: "git-commit-hash",
		text: "The regression landed in commit d8cc3baed67acf89d7ddb50f22e7a3aa3ee336aa on master.",
		mustSurvive: ["d8cc3baed67acf89d7ddb50f22e7a3aa3ee336aa"],
	},
	{
		id: "sha256-artifact-hash",
		text: "The wheel hash is dc808472c33885da5e1733c8244d249c99c36d05602f330fb21e268ff72afa9f per the manifest.",
		mustSurvive: ["dc808472c33885da5e1733c8244d249c99c36d05602f330fb21e268ff72afa9f"],
	},
	{
		id: "token-bucket-engineering",
		text: "We throttle with a token bucket: the token count refills at 50 per second.",
		mustSurvive: ["token bucket", "50 per second"],
	},
	{
		id: "bearer-of-news",
		text: "I hate being the bearer of bad news but the deploy failed again.",
		mustSurvive: ["bearer of bad news", "deploy failed"],
	},
	{
		id: "json-non-secret-keys",
		text: 'The manifest is {"api_version": "2026-08-01", "tokenizer": "bpe-32k", "region": "weur"} unchanged.',
		mustSurvive: ["api_version", "2026-08-01", "tokenizer", "bpe-32k"],
	},
	{
		id: "yaml-non-secret-keys",
		text: "The chart sets:\n  token_budget: 4096\n  passwordless: true",
		mustSurvive: ["token_budget: 4096", "passwordless: true"],
	},
];
