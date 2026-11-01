// Permission Prompt: bridge pushes permission_request; we reply permission_reply.
import { state } from '../state.js';
import {
  createCodexPermissionController,
  isCodexPermissionRequest,
} from './permission-codex.js';

var _req = null;
var _askQuestions = null;
var _askIndex = 0;
var _askAnswers = [];
var _deferredPrompt = null;
var _promptObserver = null;

var codexPermission = createCodexPermissionController({
  renderPrompt: renderPrompt,
  reply: reply,
  dismiss: dismissPermissionPrompt,
  buildToolSummary: buildToolSummary,
});

function getReadyMessageContainer() {
  return document.querySelector('.messages:not(.skeleton-messages)');
}

function pinPermissionPromptToBottom() {
  var promptEl = document.getElementById('permission-prompt');
  var content = document.getElementById('content');
  if (!promptEl || !promptEl.isConnected || !content) return;
  function pin() {
    if (!promptEl.isConnected) return;
    content.scrollTop = content.scrollHeight;
  }
  pin();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pin);
}

function reply(payload) {
  var send = (typeof wsSendReliable === 'function') ? wsSendReliable : wsSend;
  send(Object.assign({
    action: 'permission_reply',
    sessionId: state.wsSessionId,
    device: state.appState.device || '',
  }, payload));
}

function resetClaudeState() {
  _askQuestions = null;
  _askIndex = 0;
  _askAnswers = [];
}

function stopPromptObserver() {
  if (_promptObserver) _promptObserver.disconnect();
  _promptObserver = null;
}

function revealDeferredPrompt() {
  if (!_deferredPrompt) return false;
  if (_deferredPrompt.sessionId && state.wsSessionId
    && _deferredPrompt.sessionId !== state.wsSessionId) {
    _deferredPrompt = null;
    stopPromptObserver();
    return false;
  }
  if (!getReadyMessageContainer()) return false;
  var message = _deferredPrompt;
  _deferredPrompt = null;
  stopPromptObserver();
  showPermissionPrompt(message);
  return true;
}

function deferPermissionPrompt(msg) {
  _deferredPrompt = msg;
  if (_promptObserver || typeof window.MutationObserver !== 'function') return;
  var content = document.getElementById('content');
  if (!content) return;
  _promptObserver = new window.MutationObserver(revealDeferredPrompt);
  _promptObserver.observe(content, { childList: true, subtree: true });
}

function showPermissionPrompt(msg) {
  if (!getReadyMessageContainer()) {
    deferPermissionPrompt(msg);
    return false;
  }
  _deferredPrompt = null;
  stopPromptObserver();
  _req = {
    requestId: msg.requestId,
    kind: msg.kind || 'tool',
  };
  resetClaudeState();
  codexPermission.reset();

  if (isCodexPermissionRequest(msg)) {
    codexPermission.show(msg);
    return true;
  }
  if (msg.kind === 'ask') {
    _askQuestions = (msg.questions && msg.questions.length)
      ? msg.questions
      : [msg.input || {}];
    renderAskStep();
    return true;
  }
  if (msg.kind === 'plan') {
    renderPrompt({
      title: 'Accept this plan?',
      description: msg.plan || (msg.input && msg.input.plan) || '',
      options: [
        { label: 'Yes, proceed', act: 'plan-accept' },
        {
          label: 'No, keep planning',
          act: 'plan-reject',
          hasInput: true,
          placeholder: 'Tell Claude what to do instead...',
        },
      ],
    });
    return true;
  }
  var summary = buildToolSummary(msg.toolName, msg.input || {});
  renderPrompt({
    title: summary.title,
    description: summary.description,
    options: [
      { label: 'Yes', act: 'allow', key: '1' },
      { label: 'No', act: 'deny', key: '2' },
    ],
  });
  return true;
}

function renderPrompt(prompt) {
  var existing = document.getElementById('permission-prompt');
  if (existing) existing.remove();

  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = true;
    inputBar.querySelectorAll('.input-row button').forEach(function (button) {
      button.disabled = true;
    });
  }

  var container = getReadyMessageContainer();
  if (!container) return;
  container.classList.add('has-permission-prompt');

  var html = '<div class="permission-prompt" id="permission-prompt">';
  html += '<div class="permission-header"><div class="permission-title">'
    + esc(prompt.title || 'Confirm?') + '</div>'
    + '<button class="permission-close" onclick="cancelPermissionPrompt()" '
    + 'title="Cancel (Esc)">&times;</button></div>';
  if (prompt.description) {
    html += '<pre class="permission-desc">' + esc(prompt.description) + '</pre>';
  }
  html += '<div class="permission-options">';
  for (var i = 0; i < prompt.options.length; i++) {
    var option = prompt.options[i];
    var buttonClass = option.tone === 'deny' || /deny|reject|no/i.test(option.act || '')
      ? 'permission-btn deny'
      : 'permission-btn allow';
    html += '<button class="' + buttonClass + '" data-act="' + esc(option.act) + '" '
      + 'data-has-input="' + (option.hasInput ? '1' : '0') + '" '
      + (option.toggle ? 'data-toggle="1" ' : '')
      + 'onclick="handlePermissionOption(this)">'
      + (option.toggle ? '<span class="permission-check"></span>' : '')
      + (option.key ? '<span class="permission-key">' + esc(option.key) + '</span>' : '')
      + '<span class="permission-copy">'
      + '<span class="permission-label">' + esc(option.label) + '</span>'
      + (option.description
        ? '<span class="permission-desc-inline">' + esc(option.description) + '</span>'
        : '')
      + '</span>'
      + '</button>';
    if (option.hasInput) {
      // A form submit fires for the soft-keyboard Enter, whose keydown reports keyCode 229.
      html += '<form class="permission-input-wrap" style="display:none" '
        + 'onsubmit="event.preventDefault();submitPermissionWithInput('
        + 'this.querySelector(\'input\'),\'' + esc(option.act) + '\')">'
        + '<input class="permission-input" placeholder="' + esc(option.placeholder || '') + '" '
        + 'enterkeyhint="' + esc(option.enterKeyHint || 'send') + '" '
        + (prompt.nextLabel ? 'oninput="updatePermissionNext()" ' : '') + '/>'
        + (option.submitLabel !== ''
          // Keep input focus on press so the closing keyboard cannot move the button away.
          ? '<button type="submit" class="permission-submit" '
            + 'onpointerdown="event.preventDefault()">' + esc(option.submitLabel || 'Send')
            + '</button>'
          : '')
        + '</form>';
    }
  }
  if (prompt.nextLabel) {
    html += '<button class="permission-btn allow permission-next" disabled '
      + 'onclick="submitPermissionMulti()">' + esc(prompt.nextLabel) + '</button>';
  }
  html += '</div></div>';

  container.insertAdjacentHTML('beforeend', html);
  if (typeof updateSpinner === 'function') updateSpinner();
  pinPermissionPromptToBottom();
}

function renderAskStep() {
  var question = _askQuestions[_askIndex] || {};
  var prefix = _askQuestions.length > 1
    ? '[' + (_askIndex + 1) + '/' + _askQuestions.length + '] '
    : '';
  var header = question.header ? '[' + question.header + '] ' : '';
  var multi = !!question.multiSelect;
  var nextLabel = _askIndex < _askQuestions.length - 1 ? 'Next' : 'Submit';
  var options = (question.options || []).map(function (option, index) {
    return {
      label: option.label,
      description: option.description || '',
      act: 'opt:' + index,
      toggle: multi,
    };
  });
  options.push({
    label: 'Type something…',
    act: 'type',
    hasInput: true,
    placeholder: 'Type your response…',
    enterKeyHint: nextLabel === 'Next' ? 'next' : 'done',
    submitLabel: multi ? '' : nextLabel,
  });
  renderPrompt({
    title: prefix + header + (question.question || question.text || ''),
    options: options,
    nextLabel: multi ? nextLabel : '',
  });
}

function multiAnswers() {
  var prompt = document.getElementById('permission-prompt');
  if (!prompt) return [];
  var question = _askQuestions[_askIndex] || {};
  var answers = [];
  prompt.querySelectorAll('.permission-btn.selected').forEach(function (button) {
    var option = (question.options || [])[parseInt(button.getAttribute('data-act').slice(4), 10)];
    if (option) answers.push(option.label);
  });
  var input = prompt.querySelector('.permission-input');
  var typed = input && input.closest('.permission-input-wrap').style.display !== 'none'
    ? (input.value || '').trim()
    : '';
  if (typed) answers.push(typed);
  return answers;
}

function updatePermissionNext() {
  var next = document.querySelector('#permission-prompt .permission-next');
  if (next) next.disabled = !multiAnswers().length;
}

function submitPermissionMulti() {
  if (!_req || !_askQuestions) return;
  var answers = multiAnswers();
  if (answers.length) recordAskAnswer(answers.join(', '));
}

function handlePermissionOption(button) {
  var act = button.getAttribute('data-act');
  if (button.getAttribute('data-has-input') === '1') {
    var wrapper = button.nextElementSibling;
    if (wrapper && wrapper.classList.contains('permission-input-wrap')) {
      var visible = wrapper.style.display !== 'none';
      wrapper.style.display = visible ? 'none' : 'flex';
      if (!visible) wrapper.querySelector('input').focus();
      updatePermissionNext();
      pinPermissionPromptToBottom();
      return;
    }
  }
  if (button.getAttribute('data-toggle') === '1') {
    button.classList.toggle('selected');
    updatePermissionNext();
    return;
  }
  var label = button.querySelector('.permission-label');
  chooseOption(act, label ? label.textContent : act);
}

function submitPermissionWithInput(input, act) {
  if (_askQuestions && (_askQuestions[_askIndex] || {}).multiSelect) {
    submitPermissionMulti();
    return;
  }
  var text = (input.value || '').trim();
  if (text) chooseOption(act, text, true);
}

function chooseOption(act, label, isTyped) {
  if (!_req || codexPermission.choose(act, label, isTyped)) return;

  if (_req.kind === 'tool') {
    reply({
      requestId: _req.requestId,
      decision: act === 'allow' ? 'allow' : 'deny',
    });
    dismissPermissionPrompt();
    return;
  }
  if (_req.kind === 'plan') {
    reply({
      requestId: _req.requestId,
      decision: act === 'plan-accept' ? 'allow' : 'answer',
      ...(act === 'plan-accept' ? {} : { answerText: label }),
    });
    dismissPermissionPrompt();
    return;
  }

  var question = _askQuestions[_askIndex] || {};
  var answer = label;
  if (act !== 'type' && !isTyped) {
    var index = parseInt(act.slice(4), 10);
    var option = (question.options || [])[index];
    answer = option ? option.label : label;
  }
  recordAskAnswer(answer);
}

function recordAskAnswer(answer) {
  var question = _askQuestions[_askIndex] || {};
  _askAnswers.push({
    question: question.question || question.text || '',
    answer: answer,
  });

  if (_askIndex < _askQuestions.length - 1) {
    _askIndex++;
    renderAskStep();
    return;
  }
  var text = _askAnswers.map(function (entry) {
    return (entry.question ? entry.question + ' ' : '') + '→ ' + entry.answer;
  }).join('\n');
  reply({
    requestId: _req.requestId,
    decision: 'answer',
    answerText: text,
  });
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  if (codexPermission.cancel()) return;
  if (_req) {
    reply({ requestId: _req.requestId, decision: 'deny' });
  }
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  _req = null;
  _deferredPrompt = null;
  stopPromptObserver();
  resetClaudeState();
  codexPermission.reset();
  var prompt = document.getElementById('permission-prompt');
  if (prompt) prompt.remove();
  var container = document.querySelector('.messages');
  if (container) container.classList.remove('has-permission-prompt');
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = false;
    inputBar.querySelectorAll('.input-row button').forEach(function (button) {
      button.disabled = false;
    });
  }
  if (typeof updateSpinner === 'function') updateSpinner();
}

function resolvePermissionPrompt(requestId) {
  if (_deferredPrompt
    && (!requestId || _deferredPrompt.requestId === requestId)) {
    _deferredPrompt = null;
    stopPromptObserver();
    return true;
  }
  if (!_req || (requestId && _req.requestId !== requestId)) return false;
  dismissPermissionPrompt();
  return true;
}

function buildToolSummary(toolName, input) {
  if (toolName === 'Bash' || toolName === 'bash') {
    return {
      title: 'Run command?',
      description: input.command || input.cmd || '',
    };
  }
  if (toolName === 'Edit' || toolName === 'Write'
    || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    var filePath = input.file_path || input.path || '';
    return {
      title: toolName + ': ' + filePath,
      description: toolName === 'Write' ? 'Create/overwrite file' : 'Edit file',
    };
  }
  var description;
  try { description = JSON.stringify(input, null, 2); } catch (e) { description = ''; }
  if (description && description.length > 500) {
    description = description.slice(0, 500) + '…';
  }
  return {
    title: toolName || 'Run tool?',
    description: description,
  };
}

function hasActivePermissionPrompt() {
  return !!_req;
}

Object.assign(window, {
  showPermissionPrompt: showPermissionPrompt,
  handlePermissionOption: handlePermissionOption,
  submitPermissionWithInput: submitPermissionWithInput,
  submitPermissionMulti: submitPermissionMulti,
  updatePermissionNext: updatePermissionNext,
  cancelPermissionPrompt: cancelPermissionPrompt,
  dismissPermissionPrompt: dismissPermissionPrompt,
  resolvePermissionPrompt: resolvePermissionPrompt,
  hasActivePermissionPrompt: hasActivePermissionPrompt,
  revealDeferredPermissionPrompt: revealDeferredPrompt,
});
