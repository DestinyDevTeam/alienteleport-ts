require("dotenv").config();
import { WebService } from "tsoribase";
import {
  ActionController,
  ApiController,
  ApiRequest,
  EosAction,
  EventModel,
  EvmRouter,
  HpTable,
  HyperionRouter,
  TableModel,
  TransactionModel,
} from "tsorihyperion";
import abi from "./abi";
import config from "./config";
import { Serialize } from "eosjs";
import ethUtil from "ethereumjs-util";
import { keccak, toRpcSig } from "ethereumjs-util";
import ClaimedModel from "./models/clamedModel";
import TeleportModel from "./models/teleportModel";
import TransportModel from "./models/transportModel";
import StorageService from "./storageService";
const fromHexString = (hexString) =>
  new Uint8Array(hexString.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));

const toHexString = (bytes) =>
  bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "");
export default class AlienTeleportTs {
  constructor() {
    this.init();
  }
  async init() {
    var time = await StorageService.Get();
    var hp = new HyperionRouter(config.hyperionUrl);

    hp.addTable(
      new HpTable({
        code: config.contract,
        table: "teleports",
        start_from: time.teleportTable ?? StorageService.defaultTime,
      }),
      TransportModel,
      this.transportChanged,
      this
    );
    hp.statrtHttp("producers.", 5000);

    let evm = new EvmRouter(
      config.EVMUrl,
      config.EVMSSocketUrl,
      abi,
      config.EVMContract
    );
    evm.readEvent(
      false,
      "Claimed",
      time.evm,
      ClaimedModel,
      this.climedChanged,
      this
    );
    evm.readEvent(
      false,
      "Teleport",
      time.evmteleport,
      TeleportModel,
      this.teleportChanged,
      this
    );
  }
  async teleportChanged(data: EventModel<TeleportModel>) {
    console.log(data.data);
    let dt = data.data;
    try {
      let precision = config.precision;
      const amount = (parseInt(dt.tokens) / Math.pow(10, precision)).toFixed(
        precision
      );
      await ActionController.run(
        config.hyperionUrl,
        config.oraclePrivateKey,
        new TransactionModel({
          actions: [
            new EosAction({
              account: config.contract,
              name: "received",
              authorization: [
                {
                  actor: config.contract,
                  permission: "active",
                },
              ],
              data: {
                oracle_name: config.contract,
                to: dt.to,
                ref: data.transactionHash.replace(/^0x/, ""),
                quantity: `${amount} ${config.symbol}`,
                chain_id: dt.chainId,
                confirmed: true,
              },
            }),
          ],
        })
      );
      StorageService.Save("evmteleport", data.blockNumber);
      console.log("evm->", data.transactionHash, dt.tokens);
    } catch (exp) {
      console.log(exp.message.indexOf("Oracle has already signed"));
      console.log(exp.message);
    }
  }
  async climedChanged(data: EventModel<ClaimedModel>) {
    console.log(data.data);
    let dt = data.data;
    try {
      let precision = config.precision;
      await ActionController.run(
        config.hyperionUrl,
        config.oraclePrivateKey,
        new TransactionModel({
          actions: [
            new EosAction({
              account: config.contract,
              name: "claimed",
              authorization: [
                {
                  actor: config.contract,
                  permission: "active",
                },
              ],
              data: {
                oracle_name: config.contract,
                id: dt.id,
                to_eth: dt.to.replace("0x", "") + "000000000000000000000000",
                quantity:
                  (parseInt(dt.tokens) / Math.pow(10, precision)).toFixed(
                    precision
                  ) +
                  " " +
                  config.symbol,
              },
            }),
          ],
        })
      );
      StorageService.Save("evm", data.blockNumber);
      console.log("evm->", dt.id, dt.tokens);
    } catch (exp) {
      console.log(exp.message.indexOf("Oracle has already signed"));
      console.log(exp.message);
    }
  }
  async transportChanged(model: TableModel<TransportModel>) {
    console.log(model.data.quantity);
    try {
      if (model.data.quantity.split(" ")[1] != config.symbol) return;
    } catch (exp) {}
    let block: any = await WebService.post(
      config.hyperionUrl + "/v1/chain/get_block",
      { block_num_or_id: model.block_num },
      null,
      null
    );
    console.log(block.transactions);
    let log: any = {};
    for (let transaction of block.transactions) {
      console.log(">>>>>>", config.hyperionUrl + "/v1/history/get_transaction");
      console.log(">>>>>>", { id: transaction.trx.id });

      let trx: any = await WebService.post(
        config.hyperionUrl + "/v1/history/get_transaction",
        { id: transaction.trx.id },
        null,
        null
      );
      log = trx.traces.filter(
        (p) => p.act.name == "logteleport" && p.act.account == config.contract
      )[0];
      if (log) break;
    }
    const sb = new Serialize.SerialBuffer({
      textEncoder: new TextEncoder(),
      textDecoder: new TextDecoder(),
    });

    sb.pushNumberAsUint64(model.data.id);
    sb.pushUint32(model.data.time);
    sb.pushName(model.data.account);
    sb.pushAsset(model.data.quantity);
    sb.push(model.data.chain_id);
    sb.pushArray(fromHexString(model.data.eth_address));

    const data_serialized = "0x" + toHexString(sb.array.slice(0, 69));
    console.log(data_serialized);
    //const data_buf = Buffer.from(data_serialized);
    const msg_hash = keccak(data_serialized); // ethUtil.keccak(data_buf);
    const pk = Buffer.from(config.EVMContractPrivateKey, "hex");
    const sig = ethUtil.ecsign(msg_hash, pk);
    const signature = toRpcSig(sig.v, sig.r, sig.s); // ethUtil.toRpcSig(sig.v, sig.r, sig.s);
    console.log(signature);

    let tb = await ApiController.getTable(
      config.hyperionUrl,
      new ApiRequest({
        code: config.contract,
        scope: config.contract,
        table: "teleports",
        lower_bound: model.data.id.toString(),
        upper_bound: model.data.id.toString(),
      }),
      TransportModel
    );
    if (tb.rows.length) {
      if (tb.rows[0].oracles.indexOf(config.contract) > -1) return;
      //return;
    }
    // const action_deser = await eos_api.deserializeActions([log.act]);

    try {
      await ActionController.run(
        config.hyperionUrl,
        config.oraclePrivateKey,
        new TransactionModel({
          actions: [
            new EosAction({
              account: config.contract,
              name: "sign",
              authorization: [
                {
                  actor: config.contract,
                  permission: "active",
                },
              ],
              data: {
                oracle_name: config.contract,
                id: model.data.id,
                signature,
              },
            }),
          ],
        })
      );
      StorageService.Save("teleportTable", model.timestamp);
      console.log(signature);
    } catch (exp) {
      if (exp.message.indexOf("Oracle has already signed") > -1) {
        StorageService.Save("teleportTable", model.timestamp);
      }
      console.log(exp.message.indexOf("Oracle has already signed"));
      console.log(exp.message);
    }
  }
}

new AlienTeleportTs();
