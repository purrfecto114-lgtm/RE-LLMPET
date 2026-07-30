#!/usr/bin/env python3
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
FILES = [ROOT/'src-tauri/src/commands.rs', ROOT/'src-tauri/src/hook_install.rs', ROOT/'src-tauri/src/lib.rs']

def scan(text: str):
    stack=[]; i=0; line=1; state='code'; raw_hashes=0
    pairs={')':'(',']':'[','}':'{'}
    while i < len(text):
        c=text[i]; n=text[i+1] if i+1<len(text) else ''
        if c=='\n': line+=1
        if state=='line':
            if c=='\n': state='code'
        elif state=='block':
            if c=='*' and n=='/': state='code'; i+=1
        elif state=='string':
            if c=='\\': i+=1
            elif c=='"': state='code'
        elif state=='char':
            if c=='\\': i+=1
            elif c=="'": state='code'
        elif state=='raw':
            if c=='"' and text.startswith('#'*raw_hashes, i+1):
                i += raw_hashes; state='code'
        else:
            if c=='/' and n=='/': state='line'; i+=1
            elif c=='/' and n=='*': state='block'; i+=1
            elif c=='r':
                j=i+1
                while j<len(text) and text[j]=='#': j+=1
                if j<len(text) and text[j]=='"':
                    raw_hashes=j-i-1; state='raw'; i=j
            elif c=='"': state='string'
            elif c=="'":
                # Rust lifetimes are not character literals. Only enter char state
                # when a closing quote is visible within a small token.
                close=text.find("'", i+1, min(len(text), i+8))
                if close!=-1: state='char'
            elif c in '([{': stack.append((c,line))
            elif c in ')]}':
                if not stack or stack[-1][0] != pairs[c]:
                    return f'unmatched {c} at line {line}'
                stack.pop()
        i+=1
    if state in {'block','string','char','raw'}: return f'unterminated {state}'
    if stack: return f'unclosed {stack[-1][0]} from line {stack[-1][1]}'
    return None

failed=[]
for file in FILES:
    issue=scan(file.read_text(encoding='utf-8'))
    if issue: failed.append(f'{file.relative_to(ROOT)}: {issue}')
    else: print(f'PASS {file.relative_to(ROOT)}')
if failed:
    print('\n'.join('FAIL '+x for x in failed), file=sys.stderr); sys.exit(1)
