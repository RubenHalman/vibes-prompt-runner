#!/usr/bin/env python3
"""Extract structured sections from an ava log file.

Usage: python3 extract-log.py <log-file>
Output: JSON with keys: answer, summary, optimization
"""
import sys, re, json

text = open(sys.argv[1], errors='replace').read()
bar = '\u2550' * 60


def last_section(title):
    pat = re.escape(bar) + r'\n  ' + re.escape(title) + r'\n' + re.escape(bar) + r'\n(.*?)' + re.escape(bar)
    matches = re.findall(pat, text, re.DOTALL)
    return matches[-1].strip() if matches else ''


# Find all plain AGENTFORCE rounds (no suffix) to get the last round number.
plain_rounds = re.findall(
    re.escape(bar) + r'\n  AGENTFORCE \u2014 Round (\d+)\n' + re.escape(bar),
    text,
)
last_round = plain_rounds[-1] if plain_rounds else None

answer = ''
if last_round:
    # Prefer the "(last message)" variant — it's the DOM-extracted agent response,
    # which contains only Agentforce's reply without the prompt echo.
    # The plain "Round N" section is a page-text diff that includes the user prompt
    # on Round 1, so we only fall back to it when no "(last message)" variant exists.
    last_msg = last_section(f'AGENTFORCE \u2014 Round {last_round} (last message)')
    if last_msg:
        answer = last_msg
    else:
        plain = last_section(f'AGENTFORCE \u2014 Round {last_round}')
        answer = plain

print(json.dumps({
    'answer':       answer[:4000],
    'summary':      last_section('RUN SUMMARY')[:2000],
    'optimization': last_section('PROMPT_OPTIMIZATION')[:2000],
}))
