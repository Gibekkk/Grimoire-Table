import re
def dice(s):
    s=re.sub(r"\b([0-9lIOS]{0,2})\s?d\s?([0-9lIO][0-9lIO ]{0,2})\b",lambda m:(m.group(1).replace('l','1').replace('I','1').replace('O','0').replace('S','5'))+'d'+m.group(2).replace(' ','').replace('l','1').replace('I','1').replace('O','0'),s)
    s=re.sub(r"\blevel S\+","level 5+",s)
    return s
def flow(s):
    s=re.sub(r"(?<![.:!?\"”)])\n(?=\S)"," ",s)
    s=re.sub(r"^[;:,.'\s]+","",s)
    s=re.sub(r"[ ]{2,}"," ",s)
    return s.strip()
def fix(s): return flow(dice(s))
