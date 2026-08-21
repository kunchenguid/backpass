#!/usr/bin/env node
import { main } from '../src/cli.js';

process.exitCode = await main(process.argv.slice(2));
