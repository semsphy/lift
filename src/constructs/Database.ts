import { Construct as CdkConstruct, CfnOutput, Duration, SecretValue } from "@aws-cdk/core";
import { FromSchema } from "json-schema-to-ts";
import {
    Credentials,
    DatabaseInstance,
    DatabaseInstanceEngine,
    MariaDbEngineVersion,
    MysqlEngineVersion,
    PostgresEngineVersion,
} from "@aws-cdk/aws-rds";
import { InstanceType, SubnetType } from "@aws-cdk/aws-ec2";
import { AwsCfInstruction } from "@serverless/typescript";
import { IInstanceEngine } from "@aws-cdk/aws-rds/lib/instance-engine";
import { RetentionDays } from "@aws-cdk/aws-logs";
import { AwsConstruct, AwsProvider } from "../classes";

const SCHEMA = {
    type: "object",
    properties: {
        name: {
            type: "string",
            pattern: "^[\\w\\d-_]*$/",
        },
        password: {
            type: "string",
            minLength: 8,
        },
        engine: {
            type: "string",
            enum: ["mysql", "mariadb", "postgres"],
        },
        instanceType: { type: "string" },
        storageSize: {
            type: "integer",
            minimum: 20,
        },
    },
    additionalProperties: false,
    required: ["password"],
} as const;

type Configuration = FromSchema<typeof SCHEMA>;

export class Database extends AwsConstruct {
    public static type = "database";
    public static schema = SCHEMA;

    private readonly dbInstance: DatabaseInstance;
    private readonly dbHostOutput: CfnOutput;

    constructor(
        scope: CdkConstruct,
        id: string,
        private readonly configuration: Configuration,
        private readonly provider: AwsProvider
    ) {
        super(scope, id);

        const vpc = provider.enableVpc();

        // this.secret = new Secret(this, "Secret", {
        //     description: `Secret to store the ${id} database password`,
        //     secretName: `${this.provider.stackName}/${id}`,
        //     generateSecretString: {
        //         secretStringTemplate: JSON.stringify({ username: "admin" }),
        //         generateStringKey: "password",
        //     },
        // });

        this.dbInstance = new DatabaseInstance(this, "Instance", {
            // https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_aws-rds.DatabaseInstance.html#construct-props
            instanceIdentifier: configuration.name ?? `${this.provider.stackName}-${id}`,
            databaseName: this.safeDbName(configuration.name ?? `${this.provider.stackName}-${id}`),
            engine: this.getEngineVersion(),
            instanceType: new InstanceType(configuration.instanceType ?? "t3.micro"),
            // TODO use Secret Manager
            credentials: Credentials.fromPassword("admin", SecretValue.plainText(configuration.password)),
            vpc,
            // Put the instance in the private subnet
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE,
            },
            // We go with 20 (the minimum) instead of 100 by default, because it is much cheaper
            allocatedStorage: configuration.storageSize ?? 20,
            // 7 days backups instead of the default 1
            backupRetention: Duration.days(7),
            // TODO Enable logs by default
            cloudwatchLogsExports: [""],
            cloudwatchLogsRetention: RetentionDays.ONE_WEEK,
        });

        // TODO proxy (does it make sense for a dev database?)

        this.dbHostOutput = new CfnOutput(this, "DbHost", {
            value: this.dbInstance.instanceEndpoint.hostname,
        });
    }

    commands(): Record<string, () => void | Promise<void>> {
        return {};
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            host: () => this.provider.getStackOutput(this.dbHostOutput),
        };
    }

    references(): Record<string, AwsCfInstruction> {
        return {
            host: this.provider.getCloudFormationReference(this.dbInstance.instanceEndpoint.hostname),
            port: this.provider.getCloudFormationReference(this.dbInstance.instanceEndpoint.port),
        };
    }

    private safeDbName(name: string): string {
        return name.replace(/-/g, "").replace(/_/g, "");
    }

    private getEngine() {
        return this.configuration.engine ?? "mysql";
    }

    private getEngineVersion(): IInstanceEngine {
        switch (this.getEngine()) {
            case "mysql":
                return DatabaseInstanceEngine.mysql({
                    version: MysqlEngineVersion.of("8.0.23", "8.0"),
                });
            case "mariadb":
                return DatabaseInstanceEngine.mariaDb({
                    version: MariaDbEngineVersion.of("10.5.8", "10.5"),
                });
            case "postgres":
                return DatabaseInstanceEngine.postgres({
                    version: PostgresEngineVersion.of("13.2", "13"),
                });
        }
    }
}
