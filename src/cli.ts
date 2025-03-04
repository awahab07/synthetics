#!/usr/bin/env node

/**
 * MIT License
 *
 * Copyright (c) 2020-present, Elastic NV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import { stdin, cwd } from 'process';
import { resolve } from 'path';
import merge from 'deepmerge';
import { step, journey } from './core';
import { log } from './core/logger';
import program, { options } from './parse_args';
import { expect } from './core/expect';
import {
  findPkgJsonByTraversing,
  isDepInstalled,
  isDirectory,
  totalist,
  parseNetworkConditions,
} from './helpers';
import { run } from './';
import { readConfig } from './config';

const resolvedCwd = cwd();
/**
 * Set debug based on DEBUG ENV and -d flags
 * namespace - synthetics
 */
const namespace = 'synthetics';
if (process.env.DEBUG === namespace || Boolean(options.debug)) {
  process.env.DEBUG = '1';
}

const loadInlineScript = source => {
  const scriptFn = new Function(
    'step',
    'page',
    'context',
    'browser',
    'params',
    'expect',
    source
  );
  journey('inline', async ({ page, context, browser, params }) => {
    scriptFn.apply(null, [step, page, context, browser, params, expect]);
  });
};

async function readStdin() {
  const chunks = [];
  stdin.resume();
  stdin.setEncoding('utf-8');
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return chunks.join();
}

function requireSuites(suites: Iterable<string>) {
  for (const suite of suites) {
    require(suite);
  }
}

/**
 * Handle both directory and files that are passed through TTY
 * and add them to suites
 */
async function prepareSuites(inputs: string[]) {
  const suites = new Set<string>();
  const addSuite = absPath => {
    log(`Processing file: ${absPath}`);
    suites.add(require.resolve(absPath));
  };
  /**
   * Match all files inside the directory with the
   * .journey.{mjs|cjs|js|ts) extensions
   */
  const pattern = options.pattern
    ? new RegExp(options.pattern, 'i')
    : /.+\.journey\.([mc]js|[jt]s?)$/;
  /**
   * Ignore node_modules by default when running suites
   */
  const ignored = /node_modules/i;

  for (const input of inputs) {
    const absPath = resolve(resolvedCwd, input);
    /**
     * Validate for package.json file before running
     * the suites
     */
    findPkgJsonByTraversing(absPath, resolvedCwd);
    if (isDirectory(absPath)) {
      await totalist(absPath, (rel, abs) => {
        if (pattern.test(rel) && !ignored.test(rel)) {
          addSuite(abs);
        }
      });
    } else {
      addSuite(absPath);
    }
  }
  return suites.values();
}

(async () => {
  /**
   * Transform `.ts` files out of the box by invoking
   * the `ts-node` via `transpile-only` mode that compiles
   * TS files without doing any extensive type checks.
   *
   * We must register `ts-node` _before_ loading inline
   * scripts too because otherwise we will not be able to
   * require `.ts` configuration files.
   */
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: {
      esModuleInterop: true,
      allowJs: true,
      target: 'es2018',
    },
  });

  if (options.inline) {
    const source = await readStdin();
    loadInlineScript(source);
  } else {
    /**
     * Preload modules before running the suites
     */
    const modules = [].concat(options.require || []).filter(Boolean);
    for (const name of modules) {
      if (isDepInstalled(name)) {
        require(name);
      } else {
        throw new Error(`cannot find module '${name}'`);
      }
    }
    /**
     * Handle piped files by reading the STDIN
     * ex: ls example/suites/*.js | npx @elastic/synthetics
     */
    const files =
      program.args.length > 0
        ? program.args
        : (await readStdin()).split('\n').filter(Boolean);
    const suites = await prepareSuites(files);
    requireSuites(suites);
  }

  /**
   * Use the NODE_ENV variable to control the environment
   */
  const environment = process.env['NODE_ENV'] || 'development';
  /**
   * Validate and handle configs
   */
  const config =
    options.config || !options.inline
      ? readConfig(environment, options.config)
      : {};
  const params = merge(config.params, options.params || {});

  /**
   * Favor playwright options passed via cli to inline playwright options
   */
  const playwrightOptions = merge.all([
    config.playwrightOptions || {},
    options.playwrightOptions || {},
    {
      headless: options.headless,
      chromiumSandbox: options.sandbox,
      ignoreHTTPSErrors: options.ignoreHttpsErrors,
    },
  ]);

  const results = await run({
    params: Object.freeze(params),
    networkConditions: options.throttling
      ? parseNetworkConditions(options.throttling as string)
      : undefined,
    environment,
    playwrightOptions,
    ...options,
  });

  if (!options.quietExitCode) {
    /**
     * Exit with error status if any journey fails
     */
    for (const result of Object.values(results)) {
      if (result.status === 'failed') {
        process.exit(1);
      }
    }
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
