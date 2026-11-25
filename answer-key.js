const sessionLabAnswerKey = [1, 0, 2, 1, 2, 1, 1, 1, 2, 2];

if (typeof module !== 'undefined') {
  module.exports = sessionLabAnswerKey;
}

if (typeof window !== 'undefined') {
  window.sessionLabAnswerKey = sessionLabAnswerKey;
}
