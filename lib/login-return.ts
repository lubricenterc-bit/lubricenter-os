export function loginReturnPath(value:string|null){
  if(!value||!value.startsWith('/')||value.startsWith('//')||/[\\\r\n]/.test(value))return '/';
  try{const url=new URL(value,'https://lubricenter.invalid');if(url.origin!=='https://lubricenter.invalid'||url.pathname==='/login')return '/';return url.pathname+url.search+url.hash;}catch{return '/';}
}
