'use strict';

const fs = require('fs');

const debug = require('debug');
const puppeteer = require('puppeteer');

const packageName = JSON.parse(fs.readFileSync(`${__dirname}/package.json`, { encoding: 'utf-8' })).name;
const debugFns = new Map();

exports.setup = async (debuggerObj) => {
  debuggerObj.trace('Launch browser');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  debuggerObj.trace('Set up browser capabilities');
  await page.emulate({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko)',
    viewport: { width: 1280, height: 743 },
  });

  return { browser, page };
};

exports.Debugger = class Debugger {
  constructor(namespace) {
    this.namespace = namespace;
  }

  info(...args) {
    this._log('info', args);
  }

  log(...args) {
    const ownArgs = [...args];
    ownArgs[0] = `${ownArgs[0]}...`;

    this._log('log', ownArgs);
  }

  trace(...args) {
    const ownArgs = [...args];
    ownArgs[0] = `${ownArgs[0]}...`;

    this._log('trace', ownArgs);
  }

  _log(level, args) {
    const namespace = `${packageName}:${this.namespace}:${level}`;
    if (!debugFns.has(namespace)) {
      debugFns.set(namespace, debug(namespace));
    }

    debugFns.get(namespace)(...args);
  }
}
