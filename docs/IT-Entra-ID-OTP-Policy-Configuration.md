# Entra ID Policy Configuration for Automated OTP Testing

## Why This Is Needed

This project uses **bc-replay** (Playwright-based) to run Business Central page scripts unattended. When test accounts have MFA enabled, bc-replay generates TOTP codes automatically using a shared secret seed — no human interaction required.

However, the default Entra ID authentication policies impose a **limit of 3 consecutive TOTP (OTP) verifications** before forcing the user back into the full Microsoft Authenticator push/approval flow. This blocks automated test execution after just a few runs because bc-replay cannot respond to Authenticator push notifications — it can only supply 6-digit TOTP codes.

This document describes what IT / Identity administrators need to configure in Microsoft Entra ID so that TOTP-based OTP remains the accepted MFA method indefinitely, without falling back to the Authenticator approval flow.

---

## The Problem

After approximately **3 successful TOTP sign-ins**, Entra ID stops accepting OTP codes and instead prompts for:

- A Microsoft Authenticator **push notification** (number matching), or
- A **passwordless phone sign-in** approval

bc-replay cannot handle these interactive prompts. The test run fails with a login timeout.

**Root cause:** Entra ID's default Authentication Strengths and Authentication Methods policies prefer the Authenticator app's push/number-matching flow over plain TOTP codes. After a few OTP uses, the system "nudges" the user toward the richer Authenticator flow.

---

## What IT Needs to Configure

### 1. Authentication Methods Policy — Allow Software OATH Tokens

Ensure **Software OATH tokens** (TOTP) is enabled as an authentication method for the test accounts.

**Where:** Entra ID portal > **Protection** > **Authentication methods** > **Policies**

| Method | Status | Target |
|--------|--------|--------|
| Software OATH tokens | **Enabled** | Test accounts or a security group containing them |
| Third-party software OATH tokens | **Enabled** | Same target group |

> If only "Microsoft Authenticator" is enabled, Entra ID will always steer users toward push notifications instead of accepting bare TOTP codes.

### 2. Disable Microsoft Authenticator Number Matching for Test Accounts

Number matching is a feature of Microsoft Authenticator that requires the user to type a number displayed on screen into the Authenticator app. This is incompatible with unattended automation.

**Where:** Entra ID portal > **Protection** > **Authentication methods** > **Microsoft Authenticator** > **Configure**

For the test account group, set:

| Setting | Value |
|---------|-------|
| Require number matching | **Disabled** (for the test group) |

Alternatively, **exclude the test accounts** from the Microsoft Authenticator method entirely and rely solely on Software OATH tokens (see step 3).

### 3. Exclude Test Accounts from Authenticator Push (Recommended)

The cleanest approach is to ensure test accounts **only** have Software OATH tokens enabled and do **not** have Microsoft Authenticator registered.

**Steps:**

1. Create a **security group** in Entra ID (e.g., `BC-Test-Automation-Accounts`)
2. Add all test accounts used by bc-replay to this group
3. In **Authentication methods > Microsoft Authenticator**, under **Target**, **exclude** this group
4. In **Authentication methods > Software OATH tokens**, under **Target**, **include** this group
5. Remove any existing Microsoft Authenticator registrations from the test accounts:
   - Entra ID portal > **Users** > select user > **Authentication methods** > delete the Authenticator entry

This forces Entra ID to always use the TOTP flow — there is no richer method to nudge toward.

### 4. Conditional Access Policy — Do Not Require Authentication Strength Beyond MFA

If your tenant uses **Conditional Access** policies with **Authentication Strengths**, check that the policy applied to test accounts does not require "Phishing-resistant MFA" or "Passwordless MFA" — both exclude plain TOTP.

**Where:** Entra ID portal > **Protection** > **Conditional Access** > relevant policy > **Grant**

| Setting | Required value |
|---------|---------------|
| Grant access | **Require multifactor authentication** |
| Authentication strength | **MFA** (the built-in default) — not "Phishing-resistant MFA" |

> The default "MFA" authentication strength accepts Software OATH tokens. The "Phishing-resistant MFA" strength does **not**.

### 5. Disable "Suggest Stronger Authentication" / System-Preferred MFA

Entra ID has a feature called **System-preferred multifactor authentication** that automatically selects the "most secure" method registered for a user. When enabled, it overrides the user's default method choice and may force Authenticator push even when the user registered TOTP.

**Where:** Entra ID portal > **Protection** > **Authentication methods** > **Settings**

| Setting | Value |
|---------|-------|
| System-preferred multifactor authentication | **Disabled** for the test group, or tenant-wide if acceptable |

With this disabled, Entra ID will honour the user's registered default method (Software OATH token / TOTP).

### 6. Registration Campaign — Exclude Test Accounts

Entra ID can prompt users to register for Microsoft Authenticator via a "registration campaign." Exclude test accounts so they are not prompted to switch away from TOTP.

**Where:** Entra ID portal > **Protection** > **Authentication methods** > **Registration campaign**

| Setting | Value |
|---------|-------|
| State | If enabled, **exclude** the test accounts group from the target |

---

## Summary Checklist

| # | Action | Portal Location |
|---|--------|-----------------|
| 1 | Enable Software OATH tokens for test group | Authentication methods > Policies |
| 2 | Disable number matching for test group | Authentication methods > Microsoft Authenticator > Configure |
| 3 | Exclude test group from Microsoft Authenticator | Authentication methods > Microsoft Authenticator > Target |
| 4 | Remove Authenticator registrations from test users | Users > Authentication methods |
| 5 | Set Conditional Access grant to standard "MFA" strength | Conditional Access > Policy > Grant |
| 6 | Disable system-preferred MFA for test group | Authentication methods > Settings |
| 7 | Exclude test group from registration campaign | Authentication methods > Registration campaign |

---

## What Changes on the Testing Side

Once IT applies the configuration above, the test accounts will consistently use TOTP for MFA. On the testing side, confirm:

1. **Each test account has a TOTP seed** — follow the [MFA - OTP Setup Guide](MFA%20-%20OTP%20Setup%20Guide.md) to register a Software OATH token and extract the secret key
2. **Seeds are stored in `users.json`** — the workflow runner reads `mfa_seed` per user:
   ```json
   {
     "purchaser": {
       "username": "purchaser@yourtenant.onmicrosoft.com",
       "password": "your-password-here",
       "mfa_seed": "JBSWY3DPEHPK3PXP"
     }
   }
   ```
3. **bc-replay is invoked with TOTP parameters:**
   ```powershell
   npx replay .\script.yml `
     -StartAddress "https://businesscentral.dynamics.com/TENANT/ENVIRONMENT" `
     -Authentication AAD `
     -UserNameKey BC_USERNAME `
     -PasswordKey BC_PASSWORD `
     -MultiFactorType TOTP `
     -MultiFactorSecretKey BC_MFA_SEED
   ```
4. **Re-register TOTP if the Authenticator method was removed** — after IT removes the old Authenticator registration (step 3 above), follow the setup guide again to create a fresh Software OATH token entry

---

## Verifying the Configuration

After IT applies the changes, verify by signing in manually with a test account:

1. Open an InPrivate browser window
2. Navigate to https://portal.azure.com and sign in with the test account
3. At the MFA prompt, confirm you see **"Enter code from your authenticator app"** (a 6-digit input field)
4. Confirm you do **not** see a push notification / number matching prompt
5. Repeat sign-in 5+ times — the TOTP prompt should appear every time without falling back to Authenticator

If the prompt still switches to Authenticator after a few attempts, double-check that **system-preferred MFA** is disabled and the Authenticator registration has been removed from the user.
