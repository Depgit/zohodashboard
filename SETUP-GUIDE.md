# 📊 Zoho Books Dashboard — Setup Guide
## (Super Simple • No Coding Required)

---

## ✅ BEFORE YOU START — Install These (One Time Only)

### Step 1: Install Node.js
1. Go to: **https://nodejs.org**
2. Click the big green button: **"Download Node.js (LTS)"**
3. Run the downloaded file and click "Next" through the installer
4. Done! ✅

---

## 🚀 HOW TO START YOUR DASHBOARD

### Step 2: Open Terminal (Command Prompt)

**On Windows:**
- Press `Windows key + R`
- Type `cmd` and press Enter

**On Mac:**
- Press `Cmd + Space`
- Type `Terminal` and press Enter

---

### Step 3: Go to the Dashboard Folder
In the terminal, type this command and press Enter:

```
cd path/to/zoho-dashboard
```

*(Replace "path/to/zoho-dashboard" with the actual folder location.
 For example on Windows: `cd C:\Users\YourName\Desktop\zoho-dashboard`)*

---

### Step 4: Install Required Packages (First Time Only)
Type this and press Enter:

```
npm install
```

Wait for it to finish. You'll see some text scroll by — that's normal. ✅

---

### Step 5: Set Your Login Details
Open the file called **`.env`** in the dashboard folder with Notepad (Windows) or TextEdit (Mac).

Find these two lines and change them to your own email and password:
```
ADMIN_EMAIL=admin@yourbusiness.com
ADMIN_PASSWORD=YourPassword123
```

Save the file.

---

### Step 6: Start the Dashboard
In the terminal, type this and press Enter:

```
npm start
```

You should see:
```
✅ Zoho Books Dashboard is running!
👉 Open your browser and go to: http://localhost:3000
```

---

### Step 7: Open Your Dashboard
Open your browser (Chrome, Firefox, Edge) and go to:

👉 **http://localhost:3000**

---

## 🔗 CONNECTING ZOHO BOOKS

1. **Login** to the dashboard using the email & password you set in `.env`
2. You'll see a **"Connect Zoho Books"** button — click it
3. You'll be taken to the **official Zoho login page** (zoho.in)
4. Login with your Zoho account
5. Click **"Allow"** to give the dashboard access
6. You'll be automatically redirected back to your dashboard
7. Your invoices and expenses will load automatically! 🎉

---

## 🔄 SYNCING DATA

- Click **"Sync Now"** button anytime to refresh your data
- Data is fetched live from your Zoho Books account
- The last sync time is shown at the top of the dashboard

---

## ❓ TROUBLESHOOTING

**"Cannot connect to server" error:**
→ Make sure you ran `npm start` in the terminal

**"Invalid email or password":**
→ Check the `.env` file — make sure the email/password match exactly

**Zoho shows "Invalid Client" error:**
→ Check that the Redirect URL in your Zoho API Console is set to:
   `http://localhost:3000/oauth/callback`

**Dashboard shows no data after connecting:**
→ Click "Sync Now" button

**To stop the dashboard:**
→ Go to the terminal and press `Ctrl + C`

**To restart:**
→ Type `npm start` again

---

## 🔒 SECURITY NOTES

- Your Zoho Client Secret is only in the `.env` file (never visible to browser)
- Don't share the `.env` file with anyone
- The dashboard only works on your local computer (not accessible from internet)

---

## 📞 NEED HELP?

If something doesn't work:
1. Make sure Node.js is installed (`node --version` in terminal should show a number)
2. Make sure you ran `npm install` first
3. Check that your `.env` file has the correct email/password
4. Check that the Zoho Redirect URL is exactly: `http://localhost:3000/oauth/callback`
