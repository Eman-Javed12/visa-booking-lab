# Greece Visa Automation - booking lab

Controlled research lab for the Automated Web Workflows study: Playwright and Puppeteer workers book appointments on a
local portal with fictional applicants. It only ever talks to http://localhost:3000.

## Start (Windows)
1. Install Node.js 22.5 or newer from https://nodejs.org (once).
2. Double-click `start-lab.bat`. The first start installs everything (a few minutes), then the control panel opens.
   (Or in a terminal: `npm install`, `npx playwright install chromium`, `npm start`.)

## Use
1. In the control panel log in with any username and the password `lab123`.
2. Click **Download sample Excel**, then **Load Excel** and pick the downloaded `clients.xlsx`.
3. Tick **Select All Profiles** and click **Start Selected** (or **Open** on a row to sign in to the portal by hand with any username and password).
4. After a booking, a payment tab opens. Pay with any card number; the row then shows **Paid - appointment confirmed**.
5. **Tools** holds the scheduler, fault injection and the benchmark (Playwright vs Puppeteer at 1, 5, 10 and 20 users, with CSV download).