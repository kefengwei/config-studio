const hex=s=>s.replace('#','').match(/../g).map(x=>parseInt(x,16)/255);
const lin=c=>c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);
const L=h=>{const [r,g,b]=hex(h).map(lin);return .2126*r+.7152*g+.0722*b};
const cr=(a,b)=>{const l1=L(a),l2=L(b);const hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+.05)/(lo+.05)};
const pairs=process.argv.slice(2);
for(let i=0;i+2<pairs.length;i+=3){
  const name=pairs[i], fg=pairs[i+1], bg=pairs[i+2];
  const v=cr(fg,bg);
  console.log((v>=4.5?'OK  ':(v>=3?'big ':'FAIL'))+' '+v.toFixed(2)+'  '+name);
}

