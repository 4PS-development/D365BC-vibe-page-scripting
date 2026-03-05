# MFA - OTP Setup Guide

How to enable TOTP (authenticator app) MFA on a Business Central test account and extract the seed for use with bc-replay.

> **Why this matters:** bc-replay runs tests unattended. If your test account has MFA enabled, bc-replay needs the TOTP seed so it can generate login codes automatically — no manual interaction required.

---

## Prerequisites

- A test account in Microsoft Entra ID with MFA **enforced** (or optionally enabled)
- Admin access to confirm **Software OATH tokens** are allowed as an authentication method
- An InPrivate / Incognito browser window for the setup steps below
- An authenticator app to verify the seed works (Microsoft Authenticator, Authy, etc.)

---

## Step 1 — Open Security Settings

Using an **InPrivate / Incognito** browser, navigate to:

**https://account.microsoft.com/security**

Sign in with your test account credentials, then click **Add sign-in method** (or **Add method**).

![Add sign-in method on account.microsoft.com/security](./images/MFA%20-%20add%20logon%20method.png)

---

## Step 2 — Choose Authenticator App

When prompted to choose a method, select **"I want to use a different authenticator app"** (or skip the default Microsoft Authenticator prompt and choose your own).

![Choose a different authenticator app](./images/MFA%20-%20setup%20an%20different%20authentication%20app.png)

---

## Step 3 — Configure Your Account in the App

The wizard shows a QR code. **Do not scan it yet.** Read the next step first to capture the secret key instead.

![Configure your account in the authenticator app — QR code screen](./images/MFA%20-%20configure%20you%20account%20in%20the%20app.png)

---

## Step 4 — Reveal the Secret Key (TOTP Seed)

Click **"Can't scan the QR code?"** or **"I can't scan the image"** link below the QR code. This reveals the plain-text secret key.

![Click "Can't scan the QR code" to reveal the secret key](./images/MFA%20-%20cant%20scan%20the%20Qr%20code.png)

> ⚠️ **Critical:** This secret key is your TOTP seed. It is **only shown once**. If you close this page without copying it you will need to delete the MFA method and start again.

---

## Step 5 — Copy the Secret Key

Copy the **Secret key** value displayed on screen. This is the Base32 string you will use as `BC_MFA_SEED` in bc-replay.

![Copy the secret key for manual entry in an authenticator app](./images/MFA%20-%20copy%20details%20to%20create%20manual%20entry%20in%20MS%20authenticator.png)

**Save it securely** — paste it into a password manager or secure notes immediately.

> Example format: `JBSWY3DPEHPK3PXP` (Base32, no spaces)

---

## Step 6 — Add the Account to Your Authenticator App (Mobile)

On your phone, open your authenticator app and add a new account. When given the option to scan a QR code, choose **"Enter setup key"** or **"Enter code manually"** instead.

![In the authenticator app, choose to enter the key manually instead of scanning](./images/MFA%20-%20Scan%20qr%20code%20choose%20manual.jpeg)

---

## Step 7 — Enter the Account Details and Seed

Enter a recognisable account name (e.g. the email address of the test account) and paste the secret key you copied in Step 5 into the **Key / Secret** field. Leave the type set to **Time-based**.

![Enter the account name and the OTP seed in the authenticator app](./images/MFA%20-%20enter%20account%20number%20and%20OTP%20seed.jpeg)

---

## Step 8 — Account Added in the Authenticator App

The app will show a new entry generating 6-digit codes every 30 seconds. Confirm the codes are rotating before continuing.

![Account successfully added in the authenticator app](./images/MFA%20-%20Add%20account%20in%20authenticator%20app.jpeg)

---

## Step 9 — Enter the Verification Code

Back in the browser wizard, enter the **6-digit code** currently shown in your authenticator app and click **Next / Verify**.

![Enter the 6-digit verification code from your authenticator app](./images/MFA%20-%20enter%20code%20from%20app.png)

---

## Step 10 — Method Added Successfully

You will see a confirmation that the authenticator app has been added as a sign-in method.

![Authenticator method added successfully](./images/MFA%20-%20method%20added%20succesfull.png)

---

## Step 11 — Set as Default Sign-in Method

To ensure MFA via the authenticator app is used consistently, set it as the **default sign-in method**.

Click **Change** next to the default method:

![Set default sign-in method — select authenticator app](./images/MFA%20-%20set%20default%20logon%20method.png)

Confirm the selection:

![Confirm authenticator app as default sign-in method](./images/MFA%20-%20set%20default%20logon%20method%201.png)

---

## Step 12 — Use the Seed with bc-replay

Store the seed as an environment variable and pass it to bc-replay using the native `-MultiFactorType TOTP` parameter:

```powershell
$env:BC_USERNAME = "testuser@yourtenant.onmicrosoft.com"
$env:BC_PASSWORD  = "YourPassword"
$env:BC_MFA_SEED  = "JBSWY3DPEHPK3PXP"   # ← the secret key from Step 5

npx replay .\scripts\your-script.yml `
  -StartAddress "https://businesscentral.dynamics.com/TENANT/ENVIRONMENT" `
  -Authentication AAD `
  -UserNameKey BC_USERNAME `
  -PasswordKey BC_PASSWORD `
  -MultiFactorType TOTP `
  -MultiFactorSecretKey BC_MFA_SEED
```

For the multi-user workflow runner, add the seed to your `users.json`:

```json
{
  "purchaser": {
    "username": "purchaser@yourtenant.onmicrosoft.com",
    "password": "YourPassword",
    "mfa_seed": "JBSWY3DPEHPK3PXP"
  }
}
```

> `users.json` is gitignored. Never commit passwords or seeds.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Verification code rejected | Wrong seed or clock drift | Check seed is copied exactly; ensure system time is synced |
| "Can't scan image?" link not visible | Older UI flow | Scroll down on the QR code screen |
| Seed not accepted in authenticator | Spaces in the key | Remove all spaces from the Base32 string |
| ``BC_MFA_SEED`` not found | Env var not set before npx call | Set the variable in the same terminal session that runs npx |
| Method setup forced to Microsoft Authenticator | Tenant policy | Ask your admin to allow any TOTP authenticator (Software OATH tokens) |

---

## Related Documentation

- [BC_REPLAY_QUICK_START.md — MFA section](../bc-replay/BC_REPLAY_QUICK_START.md#-mfa-support-native-totp) — full bc-replay parameter reference
- [bc-replay README](../bc-replay/README.md) — overview and quick start
- [Microsoft account security settings](https://account.microsoft.com/security)
