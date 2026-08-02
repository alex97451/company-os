const origin = process.env.OPS_LAN_ORIGIN;
const username = process.env.OPS_OPERATOR_USERNAME;
const password = process.env.OPS_OPERATOR_PASSWORD;

if (!origin || !username || !password) {
  throw new Error("LAN_OPERATOR_NOT_CONFIGURED");
}

const login = await fetch(`${origin}/api/ops/auth/login`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: origin,
  },
  body: JSON.stringify({ username, password }),
});
const loginBody = await login.json();
if (!login.ok || loginBody.role !== "operator" || loginBody.actorId !== username) {
  throw new Error(`LAN_OPERATOR_LOGIN_FAILED:${login.status}`);
}

const setCookies = login.headers.getSetCookie();
const cookieHeader = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
const csrfCookie = setCookies
  .map((value) => value.match(/^company_os_ops_csrf=([^;]+)/)?.[1])
  .find(Boolean);
if (!csrfCookie || !cookieHeader.includes("company_os_ops_session=")) {
  throw new Error("LAN_OPERATOR_COOKIES_MISSING");
}

const ownerOnly = await fetch(`${origin}/api/ops/operator-access`, {
  headers: { Cookie: cookieHeader },
});
if (ownerOnly.status !== 403) {
  throw new Error(`LAN_OPERATOR_OWNER_BOUNDARY_FAILED:${ownerOnly.status}`);
}

const presence = await fetch(`${origin}/api/ops/presence`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    Origin: origin,
    "x-company-os-csrf": decodeURIComponent(csrfCookie),
  },
  body: JSON.stringify({ activeView: "overview" }),
});
if (!presence.ok) {
  const body = await presence.text();
  throw new Error(`LAN_OPERATOR_PRESENCE_FAILED:${presence.status}:${body.slice(0, 200)}`);
}

console.log(`LAN operator verified at ${origin}/ops (login, permissions and presence).`);
