'use strict';

const assert = require('assert');
const url = require('url');
const puppeteer = require('puppeteer');
const { Debugger, setup } = require('../util');

assert(process.env.CBA_LOGIN, 'CBA_LOGIN environment variable is not defined');
assert(process.env.CBA_PASSWORD, 'CBA_PASSWORD environment variable is not defined');

process.on('unhandledRejection', (err) => {
  throw new Error(err.message);
});

(async () => {
  const debuggerObj = new Debugger('cba-appartment-rent');
  const { browser, page } = await setup(debuggerObj);

  debuggerObj.log('Login into CBA control panel');
  await login(page, debuggerObj);
  debuggerObj.info('Successfully logged in');

  debuggerObj.log('Show current balance');
  const accounts = await getCurrentAccounts(page, debuggerObj);
  debuggerObj.info('Accounts: %j', accounts);

  debuggerObj.log('Detect how many payments should be processed until the next pay day');
  const pendingPayments = await detectPendingPayments(page, debuggerObj);
  debuggerObj.info('Pending payments number: %d', pendingPayments);

  debuggerObj.log('Process remaining payments until the next pay day');
  await processPendingPayments(page, debuggerObj, pendingPayments);
  debuggerObj.info('Payments processed');

  debuggerObj.log('Suspend these payments');

  debuggerObj.trace('Finish session');
  await browser.close();
})();

async function login(page, debuggerObj) {
  debuggerObj.trace('Load CBA index page');
  await page.goto('https://www.commbank.com.au/');

  debuggerObj.trace('Click on login button');
  await page.click('.logged-state-button a');

  debuggerObj.trace('Wait until login frame is visible');
  await page.waitForSelector('aside.login-panel.open');

  debuggerObj.trace('Wait until login frame form is visible');
  const loginFrame = page.mainFrame().childFrames()[0];
  await loginFrame.waitForSelector('input[name="txtMyClientNumber$field"]');

  debuggerObj.trace('Fill login frame form with credentials');
  await loginFrame.evaluate((login, password) => {
    const loginInput = document.querySelector('input[name="txtMyClientNumber$field"]');
    loginInput.value = login;

    const passwordInput = document.querySelector('input[name="txtMyPassword$field"]');
    passwordInput.value = password;

    const submitButton = document.querySelector('#btnLogon input[type="submit"]');
    submitButton.click();
  }, process.env.CBA_LOGIN, process.env.CBA_PASSWORD);

  debuggerObj.trace('Wait until login process is successfully finished');
  await page.waitForSelector('#ctl00_HeaderControl_logOffLink');
}

async function getCurrentAccounts(page, debuggerObj) {
  debuggerObj.trace('Wait until account portfolio is visible');
  await page.waitForSelector('#ctl00_BodyPlaceHolder_MyPortfolioGrid1_a');

  debuggerObj.trace('Iterate through all accounts');
  return page.evaluate(() => {
    const output = {};

    for (let row of document.querySelectorAll('.main_group_account_row')) {
      const accountName = row.querySelector('.NicknameField div.left a').innerText;
      const details = row.querySelector('.BSBField .text').innerText;
      const accountNumber = row.querySelector('.AccountNumberField .text').innerText;
      const balance = row.querySelector('.AvailableFundsField').innerText;

      output[accountName] = {
        balance,
        details,
        number: accountNumber,
      };
    }

    return output;
  });
}

async function detectPendingPayments(page, debuggerObj) {
  debuggerObj.trace('Click on "View all future bill payments" link');
  await page.click('.homeDBBL a[href*="netbank/Container/ESD/Bills.Management"]');

  debuggerObj.trace('Wait until upcoming bills list is loaded');
  await page.waitForSelector('#app');
  debuggerObj.trace('App iframe exists');
  await page.waitFor(3000); // looks like the iframe is created after an app is initialized
  const billsFrame = page.mainFrame().childFrames()[0];
  await billsFrame.waitForSelector('#upcomingBillsList');

  debuggerObj.trace('Iterate through all upcoming payments');
  const nextPayDate = calculateNextPayDate();
  return await billsFrame.evaluate((nextPayDateSerialized) => {
    const nextPayDate = new Date(nextPayDateSerialized);
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    let output = 0;

    for (let dueDateElem of document.querySelectorAll('.dueDateMobile')) {
      const [ dueDay, dueMonth ] = dueDateElem.innerHTML.split('/').map(num => parseInt(num, 10));
      const dueYear = dueMonth < currentMonth ? currentYear + 1 : currentYear;
      const dueDate = new Date(`${dueYear}-${dueMonth}-${dueDay} 23:59:59`);

      if (dueDate < nextPayDate) {
        output++;
      }
    }

    return output;
  }, nextPayDate.toDateString());
}

async function processPendingPayments(page, debuggerObj, pendingPayments) {
  debuggerObj.trace('Go to transfers and BPAY page');
  const currentUrl = page.url();
  await page.goto(url.resolve(currentUrl, '/netbank/PaymentHub/MakePayment.aspx'));

  debuggerObj.trace('Wait until favourite payments are visible');
  await page.waitForSelector('.dvFavPayments');

  debuggerObj.trace('Choose payment');
  const foundFavouritePayment = await page.evaluate(() => {
    for (let row of document.querySelectorAll('#ctl00_InformationPlaceholder_ucFavouritePayment_gvFav tr.row')) {
      const accountNumberLabel = row.querySelector('.accountNumberLabel').innerText;

      if (accountNumberLabel === 'Appartment Weekly') {
        const link = row.querySelector('a[href*="netbank/PaymentHub/MakePayment.aspx"]');
        link.click();

        return true;
      }
    }
  });

  assert(foundFavouritePayment, 'Favourite payment was not found');

  debuggerObj.trace('Fill sum, click next');
  await page.waitForSelector('#ctl00_BodyPlaceHolder_cntPnlPayCntrl');
  await page.focus('input[name="ctl00$BodyPlaceHolder$txtAmount$field"]');
  await page.type(String(585 * pendingPayments));
  await page.click('#ctl00_BodyPlaceHolder_lnkbtnPay');

  await page.screenshot({ path: 'path.png' });
}

/**
 * Calculate next pay date:
 * - if it's May 6th, it should be May 30th
 * - if it's May 28th, it should be June 15th
 * - if it's June 1st, it should be June 15th
 */
function calculateNextPayDate() {
  const now = new Date();
  const thresholdDates = [];
  let returnNextDate = false;

  for (let month = 0; month <= 12; month++) { // small hack to include next year
    for (let day of [1, 15]) {
      const thresholdDate = new Date('2000-01-01 23:59:59');
      thresholdDate.setFullYear(now.getFullYear(), month, day);
      thresholdDates.push(thresholdDate);
    }
  }

  for (let date of thresholdDates) {
    if (date > now) {
      if (returnNextDate) {
        date.setHours(0, 0, 0);
        return date;
      }

      returnNextDate = true;
    }
  }

  throw new Error('Unknown threshold date');
}
