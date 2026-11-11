import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,existsSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
process.env.ATELIER_HOME=mkdtempSync(join(tmpdir(),'atelier-chunks-'))
const assets=await import('../src/core/assets.ts')
const {routes,mutates}=await import('../src/http/api.ts')
const repo=await import('../src/db/repo.ts')
test('bounded reads reconstruct immutable bytes and retain provenance without a shared filesystem',()=>{
 const bytes=Buffer.alloc(90000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251
 const asset=assets.store(bytes,{mime:'image/png',prompt:'fixture prompt'})
 const chunks:Buffer[]=[];let offset=0
 do{const result=assets.readChunk(asset,offset,32768);assert.equal(result.sha256,asset.sha256);assert.equal(result.offset,offset);const chunk=Buffer.from(result.content,'base64');assert.equal(result.chunkSha256,createHash('sha256').update(chunk).digest('hex'));chunks.push(chunk);offset=result.nextOffset}while(offset<bytes.length)
 assert.deepEqual(Buffer.concat(chunks),bytes)
 assert.equal(assets.readChunk(asset,0,0).content,'')
 for(const [offset,length] of [[-1,1],[0,65537],[0,-1],[0,1.5],[bytes.length+1,1]])assert.throws(()=>assets.readChunk(asset,offset!,length!),/range/)
 assert.equal(mutates('/api/assets.read'),false)
 const reply=routes['/api/assets.read']!({id:asset.id,offset:2,length:5},{} as never) as any
 assert.equal(reply.asset.prompt,'fixture prompt');assert.deepEqual(Buffer.from(reply.content,'base64'),bytes.subarray(2,7))
})
test('asset read cannot cross a selected project boundary',()=>{
 const asset=assets.store(Buffer.from('private'),{mime:'image/png'})
 const other=repo.createProject('other chunk project')
 repo.withProject(other.id,()=>assert.throws(()=>routes['/api/assets.read']!({id:asset.id,offset:0,length:5},{} as never),/no asset/))
})

test('metadata lookup and daemon-host copy enforce the same project boundary',()=>{
 const asset=assets.store(Buffer.from('scoped copy'),{mime:'image/png'}),destination=join(process.env.ATELIER_HOME!,'scoped-copy.png')
 const own=routes['/api/assets.get']!({id:asset.id},{} as never) as any
 assert.equal(own.asset.id,asset.id)
 routes['/api/assets.attach']!({id:asset.id,path:destination},{} as never)
 assert.equal(readFileSync(destination).toString(),'scoped copy')
 const other=repo.createProject('metadata outsider'),denied=join(process.env.ATELIER_HOME!,'denied-copy.png')
 repo.withProject(other.id,()=>{
  assert.throws(()=>routes['/api/assets.get']!({id:asset.id},{} as never),/no asset/)
  assert.throws(()=>routes['/api/assets.attach']!({id:asset.id,path:denied},{} as never),/no asset/)
 })
 assert.equal(existsSync(denied),false)
})
