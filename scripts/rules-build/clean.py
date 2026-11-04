import re, collections, os
S=os.path.dirname(os.path.abspath(__file__))+'/txt/'
WORDS=set(w.strip().lower() for w in open('/usr/share/dict/words') if w.strip().isalpha())
# vocabulary from the books themselves (frequent unsplit tokens)
cnt=collections.Counter()
for f in ['phb-cols.txt']:
    for w in re.findall(r"[A-Za-z]+", open(S+f).read()): cnt[w.lower()]+=1
VOCAB=WORDS|{w for w,c in cnt.items() if c>=3 and len(w)>2}
GAME={'cantrip','cantrips','d4','d6','d8','d10','d12','d20','dex','str','con','int','wis','cha','gp','sp','cp','pp','ep','hp'}
VOCAB|=GAME
FIX={'l':'1','O':'0'}
def isword(w): return w.lower() in VOCAB
SHORT={'a','i','an','of','to','in','on','or','by','at','it','is','as','be','if','no','up','so','do','go','we','he','me','my','us','am','oh','ox'}
def realword(p):
    c=re.sub(r"[^A-Za-z]","",p).lower()
    if not c: return True
    if len(c)<=2: return c in SHORT
    return c in WORDS or c in GAME or cnt[c]>=25
def join_splits(line):
    toks=line.split(' ')
    out=[]; i=0
    while i<len(toks):
        merged=False
        for n in (4,3,2):
            if i+n<=len(toks):
                parts=toks[i:i+n]
                if not all(re.fullmatch(r"\(?[A-Za-z]+[.,;:!?)]*",p or '') for p in parts): continue
                # punctuation only allowed on the last part
                if any(re.search(r"[.,;:!?)]$",p) for p in parts[:-1]): continue
                cand=''.join(parts)
                core=re.sub(r"[^A-Za-z]","",cand)
                if len(core)<3: continue
                if isword(core) and not all(realword(p) for p in parts):
                    out.append(cand); i+=n; merged=True; break
                if cnt[core.lower()]>=40 and all(cnt[re.sub(r"[^A-Za-z]","",p).lower()]*3<cnt[core.lower()] for p in parts):
                    out.append(cand); i+=n; merged=True; break
        if not merged: out.append(toks[i]); i+=1
    return ' '.join(out)
SUBS=[(r"\bl hour\b","1 hour"),(r"\bl minute\b","1 minute"),(r"\bl round\b","1 round"),(r"\b0 Hit Points\b","0 Hit Points"),(r"\bO Hit Points\b","0 Hit Points"),(r"(\d) ?d ?(\d+)",r"\1d\2"),(r"\bl d(\d)",r"1d\1"),(r"(?<=\d)l\b","1"),(r"·",""),(r"\s+([,.;:])",r"\1"),(r"\bAspell\b","A spell"),(r"\bTh e\b","The"),(r"\bth e\b","the"),(r"\bI d(\d)",r"1d\1"),(r"\s{2,}"," ")]
GLUE=('the','of','a','an','in','or','to','on','and','you','your','that','is','it')
def unglue(line):
    def fix(m):
        w=m.group(0); lw=w.lower()
        if lw in WORDS or len(w)<4: return w
        for g in GLUE:
            if lw.startswith(g) and lw[len(g):] in WORDS and len(lw)-len(g)>=3: return w[:len(g)]+' '+w[len(g):]
            if lw.endswith(g) and lw[:-len(g)] in WORDS and len(lw)-len(g)>=3: return w[:-len(g)]+' '+w[-len(g):]
        return w
    return re.sub(r"[A-Za-z]+",fix,line)
def clean(text):
    text=re.sub(r"([a-z])\.([A-Z])",r"\1. \2",text)
    text=re.sub(r"-\n(?=[a-z])","",text)  # hyphenation
    lines=[unglue(join_splits(l)) for l in text.split('\n')]
    t='\n'.join(lines)
    for a,b in SUBS: t=re.sub(a,b,t)
    return t
def para(text):
    # reflow lines into paragraphs: a line ending with . followed by capital start => paragraph break when short line
    lines=[l.strip() for l in text.split('\n')]
    out=[];cur=''
    for l in lines:
        if not l:
            if cur: out.append(cur); cur=''
            continue
        if cur and re.search(r"[.:!?]$",cur) and re.match(r"[A-Z•]",l) and len(prev)<44:
            out.append(cur); cur=l
        else:
            cur=(cur+' '+l).strip() if cur else l
        prev=l
    if cur: out.append(cur)
    return '\n\n'.join(out)
prev=''
