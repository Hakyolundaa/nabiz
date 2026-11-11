# Go için .syso (COFF .rsrc) üretir: simge + manifest
import struct, sys
ico=open(sys.argv[1],'rb').read(); man=open(sys.argv[2],'rb').read(); out=sys.argv[3]
_,typ,n=struct.unpack_from('<HHH',ico,0)
images=[];grp=struct.pack('<HHH',0,1,n)
for i in range(n):
    w,h,c,r,pl,bc,sz,off=struct.unpack_from('<BBBBHHII',ico,6+16*i)
    images.append(ico[off:off+sz]); grp+=struct.pack('<BBBBHHIH',w,h,c,r,pl,bc,sz,i+1)
# (type, [(id, data)])
# sürüm bilgisi (Özellikler → Ayrıntılar): yayıncı, ürün adı, sürüm
ver=(sys.argv[4] if len(sys.argv)>4 else '1.0.0')
vp=[int(x) for x in (ver.split('.')+['0','0','0','0'])[:4]]
def pad4(b): return b+b'\0'*((4-len(b)%4)%4)
def node(key,val=b'',typ=1,children=b'',vlen=None):
    k=(key+'\0').encode('utf-16-le')
    body=pad4(struct.pack('<HHH',0,0,0)+k)[6:]      # anahtar + 4 bayt hizalama
    body+=val
    if children: body=pad4(struct.pack('<HHH',0,0,0)+body)[6:]+children
    if vlen is None: vlen=len(val)//2 if typ==1 else len(val)
    return struct.pack('<HHH',6+len(body),vlen,typ)+body
def sval(k,v): b=(v+'\0').encode('utf-16-le'); return pad4(node(k,b,1))
fixed=struct.pack('<13I',0xFEEF04BD,0x00010000,(vp[0]<<16)|vp[1],(vp[2]<<16)|vp[3],(vp[0]<<16)|vp[1],(vp[2]<<16)|vp[3],0x3F,0,0x40004,1,0,0,0)
strs=b''.join(sval(k,v) for k,v in [('CompanyName','Nabız'),('FileDescription','Nabız Kurulumu'),('FileVersion',ver),('InternalName','Nabiz-Setup'),('LegalCopyright','© 2026 Nabız'),('OriginalFilename','Nabiz-Setup.exe'),('ProductName','Nabız'),('ProductVersion',ver)])
table=pad4(node('041F04B0',b'',1,strs,0))
sfi=pad4(node('StringFileInfo',b'',1,table,0))
var=pad4(node('Translation',struct.pack('<HH',0x041F,0x04B0),0))
vfi=node('VarFileInfo',b'',1,var,0)
vsinfo=node('VS_VERSION_INFO',fixed,0,sfi+vfi,len(fixed))
tree=[(3,[(i+1,d) for i,d in enumerate(images)]),(14,[(1,grp)]),(16,[(1,vsinfo)]),(24,[(1,man)])]
LANG=0x409
dirs=bytearray(); # build sequentially: compute sizes
def dirsize(n): return 16+8*n
# layout offsets
root_off=0; off=dirsize(len(tree))
type_offs=[];
for t,items in tree: type_offs.append(off); off+=dirsize(len(items))
id_offs=[]
for t,items in tree:
    lst=[]
    for _ in items: lst.append(off); off+=dirsize(1)
    id_offs.append(lst)
data_entry_offs=[]
for t,items in tree:
    lst=[]
    for _ in items: lst.append(off); off+=16
    data_entry_offs.append(lst)
raw_offs=[]
for t,items in tree:
    lst=[]
    for _,d in items:
        off=(off+7)&~7; lst.append(off); off+=len(d)
    raw_offs.append(lst)
total=(off+7)&~7
buf=bytearray(total); relocs=[]
def put_dir(o,entries):
    struct.pack_into('<IIHHHH',buf,o,0,0,0,0,0,len(entries))
    for k,(name,target,isdir) in enumerate(entries):
        struct.pack_into('<II',buf,o+16+8*k,name,target|(0x80000000 if isdir else 0))
put_dir(0,[(t,type_offs[i],True) for i,(t,_) in enumerate(tree)])
for i,(t,items) in enumerate(tree):
    put_dir(type_offs[i],[(iid,id_offs[i][j],True) for j,(iid,_) in enumerate(items)])
    for j,(iid,d) in enumerate(items):
        put_dir(id_offs[i][j],[(LANG,data_entry_offs[i][j],False)])
        de=data_entry_offs[i][j]
        struct.pack_into('<IIII',buf,de,raw_offs[i][j],len(d),0,0)
        relocs.append(de)
        buf[raw_offs[i][j]:raw_offs[i][j]+len(d)]=d
sec_raw_ptr=20+40
reloc_ptr=sec_raw_ptr+total
sym_ptr=reloc_ptr+10*len(relocs)
coff=struct.pack('<HHIIIHH',0x8664,1,0,sym_ptr,1,0,0)
sec=struct.pack('<8sIIIIIIHHI',b'.rsrc',0,0,total,sec_raw_ptr,reloc_ptr,0,len(relocs),0,0x40000040)
rel=b''.join(struct.pack('<IIH',r,0,3) for r in relocs)
sym=struct.pack('<8sIhHBB',b'.rsrc',0,1,0,3,0)
open(out,'wb').write(coff+sec+bytes(buf)+rel+sym+struct.pack('<I',4))
print('ok',len(images),'images',total,'bytes')
