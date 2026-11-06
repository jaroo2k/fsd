import json
from pathlib import Path
from urllib.parse import urlencode
from base64 import b64encode
from urllib.request import urlopen

# Shared drawing commands keep the SVG originals and PNG presentation images consistent.
concepts = [
 ('01-document-run', 'Document to Run', [
  ('M',12,6),('L',29,6),('L',38,15),('L',38,40),('Q',38,44,34,44),('L',12,44),('Q',8,44,8,40),('L',8,10),('Q',8,6,12,6),
  ('M',28,6),('L',28,16),('L',38,16),('M',15,22),('L',23,22),('M',15,29),('L',20,29),
 ], [('M',25,25),('L',35,32),('L',25,39),('Z',)]),
 ('02-code-flow', 'Code Flow', [
  ('M',17,12),('L',5,25),('L',17,38),('M',33,12),('L',45,25),('L',33,38),
  ('M',28,10),('L',22,40),
 ], []),
 ('03-run-orbit', 'Run Orbit', [
  ('M',41,15),('C',36,5,20,3,11,12),('C',1,22,5,39,18,43),('C',28,46,38,41,42,32),
  ('M',34,15),('L',42,15),('L',42,7),
 ], [('M',21,16),('L',34,25),('L',21,34),('Z',)]),
]

def svg_path(commands):
 return ' '.join(c[0]+' '.join(str(v) for v in c[1:]) for c in commands)

urls=[]
for slug,title,lines,solid in concepts:
 mark=f'<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="{svg_path(lines)}"/></g>'
 if solid: mark+=f'<path fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" d="{svg_path(solid)}"/>'
 icon=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">{mark}</svg>\n'
 Path('docs/logo-concepts/'+slug+'.svg').write_text(icon)
 if slug.startswith('01'): Path('assets/logo.svg').write_text(icon)
 datasets=[]
 for commands in [lines,solid]:
  points=[]
  def flush():
   if points: datasets.append({'data':list(points),'borderColor':'#8fb0ff','borderWidth':5,'pointRadius':0,'fill':False,'showLine':True,'lineTension':0})
  for command in commands:
   op,*v=command
   if op=='M':
    flush(); points=[]; points.append({'x':v[0],'y':50-v[1]})
   elif op=='Z': points.append(points[0])
   elif op=='L': points.append({'x':v[0],'y':50-v[1]})
   elif op in ('Q','C'):
    x0,y0=points[-1]['x'],50-points[-1]['y']
    for i in range(1,4):
     t=i/3; u=1-t
     if op=='Q': x=u*u*x0+2*u*t*v[0]+t*t*v[2]; y=u*u*y0+2*u*t*v[1]+t*t*v[3]
     else: x=u**3*x0+3*u*u*t*v[0]+3*u*t*t*v[2]+t**3*v[4]; y=u**3*y0+3*u*u*t*v[1]+3*u*t*t*v[3]+t**3*v[5]
     points.append({'x':round(x,2),'y':round(50-y,2)})
  flush()
 config={'type':'scatter','data':{'datasets':datasets},'options':{'legend':{'display':False},'title':{'display':True,'text':title,'fontColor':'#e3e9f5','fontSize':18},'scales':{'xAxes':[{'display':False,'ticks':{'min':0,'max':50}}],'yAxes':[{'display':False,'ticks':{'min':0,'max':50}}]},'layout':{'padding':24}}}
 url='https://quickchart.io/chart?'+urlencode({'c':b64encode(json.dumps(config,separators=(',',':')).encode()).decode(),'encoding':'base64','width':280,'height':300,'devicePixelRatio':2,'format':'png','version':'2','backgroundColor':'#0e1420'})
 try:
  response=urlopen(url,timeout=60)
 except Exception as error:
  print('PNG rendering failed:', error)
  raise
 with response:
  Path('docs/logo-concepts/'+slug+'.png').write_bytes(response.read())
 urls.append({'slug':slug,'title':title,'url':url})
Path('docs/logo-concepts/previews.json').write_text(json.dumps(urls,ensure_ascii=False,indent=2)+'\n')
