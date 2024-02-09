//require('dotenv').config() 
import { WebService } from 'tsoribase';
import { ActionController, ApiController, ApiRequest, EosAction, EventModel, EvmRouter, HpTable, HyperionRouter, TableModel, TransactionModel } from 'tsorihyperion';
import abi from '../abi';
import config from '../config'; 
import { Serialize } from 'eosjs'
import ethUtil from 'ethereumjs-util';
import { express } from 'express';
import { keccak, toRpcSig } from 'ethereumjs-util';
import ClaimedModel from '../models/claimedModel'; 
import TeleportModel from '../models/teleportModel';
import TransportModel from '../models/transportModel';
import StorageService from '../storageService';
const fromHexString = hexString =>
new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)))

const toHexString = bytes =>
    bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '')
export default class AlienTeleportTs
{ 
    constructor()
    {   
        this.init();
    }
    async init()
    {  
        const PORT = process.env.PORT || 5001;

        const app = express();
        app.listen(PORT, () => console.log(`Server is listening on port ${PORT}...`));
        
        var time= await StorageService.Get();
        var hp = new HyperionRouter(process.env.HYPERION);

        hp.addTable(new HpTable({code:process.env.BRIDGE,table:'teleports',start_from:time.teleportTable??StorageService.defaultTime}),
        TransportModel,this.transportChanged, this);
        hp.statrtHttp('producers.',5000)

        let evm= new EvmRouter(process.env.EVM_URL,process.env.EVM_SOCKET,abi,process.env.EVM_CA)
        evm.readEvent(false,'Claimed',time.evm,ClaimedModel,this.claimedChanged, this)
        evm.readEvent(false,'Teleport',time.evmteleport,TeleportModel,this.teleportChanged, this) 

    }
    async teleportChanged(data:EventModel<TeleportModel>)
    {
        console.log(data.data);
        let dt=data.data
        let actions=[]
        try{ 
            let precision= Number(process.env.PRECISION)
            const amount = (parseInt(dt.tokens)  / Math.pow(10, precision)).toFixed(precision);
            await ActionController.run(process.env.HYPERION,process.env.NTV_PK,new TransactionModel({
               actions:[
                   new EosAction({
                       account: process.env.BRIDGE,
                       name: 'received',
                       authorization:[{
                           actor: process.env.NTV_ACCNT,
                           permission:  'active'
                       }],
                       data:{
                            oracle_name: process.env.NTV_ACCNT,
                            to:dt.to,
                            ref: data.transactionHash.replace(/^0x/, ''),
                            quantity: `${amount} ${process.env.TKN_SYMB}`,
                            chain_id:process.env.CHAINID,
                            confirmed: true
                       }
                   })
               ]
            }))
            StorageService.Save('evmteleport',data.blockNumber)
          console.log('evm->',data.transactionHash,dt.tokens); 
        }catch(exp){  
           console.log('-------------------------'); 
           console.log('teleportChanged'); 
           console.log(exp.message); 
           console.log(JSON.stringify(actions,null,4) );
           console.log('-------------------------'); 
        }

    }
    async claimedChanged(data:EventModel<ClaimedModel>)
    {
        console.log(data.data);
        let dt=data.data
        let actions=[]
        try{ 
            let precision=Number(process.env.PRECISION)
            await ActionController.run(process.env.HYPERION,process.env.NTV_PK,new TransactionModel({
               actions:[
                   new EosAction({
                       account: process.env.BRIDGE,
                       name: 'claimed',
                       authorization:[{
                           actor: process.env.NTV_ACCNT,
                           permission:  'active'
                       }],
                       data:{
                           oracle_name: process.env.NTV_ACCNT,
                           id:dt.id,
                           to_eth:dt.to.replace('0x', '') + '000000000000000000000000',
                           quantity:(parseInt(dt.tokens)   / Math.pow(10, precision)).toFixed(precision) + ' ' + process.env.TKN_SYMB
                       }
                   })
               ]
            }))
            StorageService.Save('evm',data.blockNumber)
          console.log('evm->',dt.id,dt.tokens); 
        }catch(exp){  
           console.log('-------------------------'); 
            console.log('claimedChanged'); 
            console.log(exp.message); 
            console.log(JSON.stringify(actions,null,4) );
            console.log('-------------------------'); 
        }
    }
    async  transportChanged(model: TableModel<TransportModel>)
    {
        try{
            if(model.data.quantity.split(' ')[1]!=process.env.TKN_SYMB)return;
            
        }catch(exp){}
        let actions=[]
        let block:any= await WebService.post(process.env.HYPERION+'/v1/chain/get_block',{block_num_or_id:model.block_num},null,null)  
        console.log(block.transactions);
        let log:any={};
        for(let transaction of block.transactions)
        {
            console.log('>>>>>>',process.env.HYPERION+'/v1/history/get_transaction');
            console.log('>>>>>>',{id:transaction.trx.id});
            
            if(transaction.trx.id)
            {
                let trx:any=  await WebService.post(process.env.HYPERION+'/v1/history/get_transaction',{id:transaction.trx.id},null,null)
                log=trx.traces.filter(p=>p.act.name=='logteleport' && p.act.account==process.env.NTV_ACCNT)[0]
                if(log) break

            }
        }
        const sb = new Serialize.SerialBuffer({
            textEncoder: new TextEncoder,
            textDecoder: new TextDecoder
        });
        
        sb.pushNumberAsUint64(model.data.id);
        sb.pushUint32(model.data.time);
        sb.pushName(model.data.account);
        sb.pushAsset(model.data.quantity);
        sb.push(model.data.chain_id);
        sb.pushArray(fromHexString(model.data.eth_address));
        
        const data_serialized =  '0x' + toHexString(sb.array.slice(0, 69));
        console.log(data_serialized);
         const data_buf = Buffer.from(data_serialized);
         const msg_hash = keccak(data_buf)// ethUtil.keccak(data_buf);
         const pk = Buffer.from(process.env.EVM_PK, "hex");
         const sig = ethUtil.ecsign(msg_hash, pk);
         const signature = toRpcSig (sig.v, sig.r, sig.s)// ethUtil.toRpcSig(sig.v, sig.r, sig.s); 
        console.log(signature);
        
        let tb=await ApiController.getTable(process.env.HYPERION,new ApiRequest({
            code:process.env.BRIDGE,
            scope:process.env.BRIDGE,
            table:'teleports',
            lower_bound:model.data.id.toString(),
            upper_bound:model.data.id.toString()
         }),TransportModel)
         if( tb.rows.length)
         {
            if(tb.rows[0].oracles.indexOf(process.env.BRIDGE)>-1)return
            //return;
         }
        // const action_deser = await eos_api.deserializeActions([log.act]);
        

         try{ 
             await ActionController.run(process.env.HYPERION,process.env.NTV_PK,new TransactionModel({
                actions:[
                    new EosAction({
                        account: process.env.BRIDGE,//brdgaa.dstny
                        name: 'sign',
                        authorization:[{
                            actor: process.env.NTV_ACCNT,//oracle.dstny
                            permission:  'active'
                        }],
                        data:{
                            oracle_name: process.env.NTV_ACCNT,//oracle.dstny
                            id: model.data.id,
                            signature
                        }
                    })
                ]
             }))
             StorageService.Save('teleportTable',model.timestamp)
           console.log(signature); 
         }catch(exp){ 
            if(exp.message.indexOf('Oracle has already signed')>-1)
            {
                StorageService.Save('teleportTable',model.timestamp)
                
            }
            console.log('-------------------------'); 
            console.log('transportChanged'); 
            console.log(exp.message); 
            console.log(JSON.stringify(actions,null,4) );
            console.log('-------------------------'); 
         }
    }
}

new AlienTeleportTs()
