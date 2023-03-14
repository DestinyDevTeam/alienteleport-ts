import ConfigModel from "./models/configModel";

const dbConnection: string = "default";
const PRECISION: number = +process.env.TKN_PRCS;

export default new ConfigModel({
  EVMSSocketUrl: "wss://telos.caleos.io/evm",
  EVMUrl: "https://telos.caleos.io/evm",
  hyperionUrl: "https://telos.caleos.io",
  oracleAccount: process.env.NTV_ACCNT,
  oraclePrivateKey: process.env.NTV_PK,
  precision: PRECISION,
  symbol: process.env.TKN_SYMB,
  contract: process.env.TKN_CNTRCT,
  EVMContract: process.env.EVM_CA,
  EVMContractPrivateKey: process.env.EVM_PK,
});
