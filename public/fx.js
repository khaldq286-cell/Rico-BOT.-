(function(){const c=document.getElementById('fx');if(!c)return;const x=c.getContext('2d');
const W=c.width=c.offsetWidth,H=c.height=c.offsetHeight;
function bolt(x1,y1,x2,y2,d){if(d<4){x.lineTo(x2,y2);return}
const mx=(x1+x2)/2+(Math.random()-.5)*d,my=(y1+y2)/2+(Math.random()-.5)*d;bolt(x1,y1,mx,my,d/2);bolt(mx,my,x2,y2,d/2)}
function loop(){x.fillStyle='rgba(2,10,6,.3)';x.fillRect(0,0,W,H);
for(let i=0;i<4;i++){const a=Math.random()*6.283,r=W*.48;x.beginPath();x.moveTo(W/2,H/2);
bolt(W/2,H/2,W/2+Math.cos(a)*r,H/2+Math.sin(a)*r,W*.3);
x.strokeStyle=i%2?'#00ff88':'#7dffff';x.shadowColor='#00ff88';x.shadowBlur=14;x.lineWidth=i?1.5:2.5;x.stroke()}
setTimeout(loop,90)}loop()})();
