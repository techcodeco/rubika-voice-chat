'use strict';

const readline = require('node:readline');
const { stdin, stdout } = require('node:process');

function ask(question, { input = stdin, output = stdout } = {}) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
    rl.once('close', () => {});
    rl.once('SIGINT', () => reject(new Error('Interactive authentication cancelled.')));
  });
}

function askSecret(question, { input = stdin, output = stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error(
      'A two-step password is required, but this process has no secure interactive TTY. ' +
      'Provide config.session.prompts.twoStepPassword to collect it securely.',
    ));
  }

  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    let value = '';
    output.write(question);
    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      output.write('\n');
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Interactive authentication cancelled.'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        output.write('\b \b');
        return;
      }
      if (character && !key.ctrl && !key.meta) {
        value += character;
        output.write('*');
      }
    };
    input.on('keypress', onKeypress);
  });
}

function createCliPrompts(options = {}) {
  return {
    phoneNumber: () => ask('Rubika phone number (international format): ', options),
    code: digits => ask(`Login code${digits ? ` (${digits} digits)` : ''}: `, options),
    twoStepPassword: hintPassKey => askSecret(`Rubika two-step verification password${hintPassKey ? ` (${String(hintPassKey)})` : ''}: `, options),
  };
}

module.exports = { ask, askSecret, createCliPrompts };
