
Devbox
=======

Devbox is a simple CLI utility written in TypeScript for creating and managing AWS EC2 machines for development work.
It is installed and updated with NPM or NPX.

### The main idea

The `devbox` CLI utility has various commands: init, add, switch, up, down, connect, and cp.
While the utility creates and manages multiple devboxes, some actions are scoped
to your `current` devbox (a single EC2 instance that is the target of specific `devbox` commands).

Calling the `devbox` command with no arguments showed you a table of all your "devboxes", their
alias string, their instance size, their EC2 status ("running", "terminated", etc.), and the last time the user connected to each devbox.
An asterisk/marker shows you your `current` devbox.

The `devbox` utility expects that the AWS environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) are set.

The `devbox` utility uses a single configuration JSON file located at `~/.config/devbox.json`, which is mostly used for setting default values (details below).

Internally, the `devbox` utility is a thin wrapper around the `aws ec2` command.

#### The `devbox init` command

The `init` command creates a new EC2 instance within the account scoped to the AWS environment variables.
When the command is successful (exit code 0) it returns the AWS Instance Id that was created.
Any non-zero exit code means the command was not successful and the command will return the error reason and relevant information.

The init command takes two arguments, an instance alias string and a file that describes the EC2 instance to create.
The instance alias string must be unique across the current local devboxes and must be a valid EC2 Instance Name string.

The main file format supported is JSON.
At some point in the future, Terraform files (in HCL format) will also be allowed, but will be parsed to JSON format internally (using [hcl2-parser](https://www.npmjs.com/package/hcl2-parser)).

The format of the JSON file is identical to the [AWS Launch Template JSON format](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-launch-template.html).
The full list of options supported is documented in the [Launch Template CloudFormation docs](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-launchtemplate-launchtemplatedata.html)
The `devbox init` instance alias string will override any "Name" tag found within the JSON file / launch template.

The format documentation is copied here:
```
{
  "BlockDeviceMappings" : [ BlockDeviceMapping, ... ],
  "CapacityReservationSpecification" : CapacityReservationSpecification,
  "CpuOptions" : CpuOptions,
  "CreditSpecification" : CreditSpecification,
  "DisableApiStop" : Boolean,
  "DisableApiTermination" : Boolean,
  "EbsOptimized" : Boolean,
  "EnclaveOptions" : EnclaveOptions,
  "HibernationOptions" : HibernationOptions,
  "IamInstanceProfile" : IamInstanceProfile,
  "ImageId" : String,
  "InstanceInitiatedShutdownBehavior" : String,
  "InstanceMarketOptions" : InstanceMarketOptions,
  "InstanceRequirements" : InstanceRequirements,
  "InstanceType" : String,
  "KernelId" : String,
  "KeyName" : String,
  "LicenseSpecifications" : [ LicenseSpecification, ... ],
  "MaintenanceOptions" : MaintenanceOptions,
  "MetadataOptions" : MetadataOptions,
  "Monitoring" : Monitoring,
  "NetworkInterfaces" : [ NetworkInterface, ... ],
  "NetworkPerformanceOptions" : NetworkPerformanceOptions,
  "Placement" : Placement,
  "PrivateDnsNameOptions" : PrivateDnsNameOptions,
  "RamDiskId" : String,
  "SecurityGroupIds" : [ String, ... ],
  "SecurityGroups" : [ String, ... ],
  "TagSpecifications" : [ TagSpecification, ... ],
  "UserData" : String
}
```

And here is the example given in the AWS Launch Template Docs:
```json
{
    "NetworkInterfaces": [{
        "AssociatePublicIpAddress": true,
        "DeviceIndex": 0,
        "Ipv6AddressCount": 1,
        "SubnetId": "subnet-0abcdef1234567890"
    }],
    "ImageId": "ami-0abcdef1234567890",
    "InstanceType": "r5.4xlarge",
    "TagSpecifications": [{
        "ResourceType": "instance",
        "Tags": [{
            "Key":"Name",
            "Value":"webserver"
        }]
    }],
    "CpuOptions": {
        "CoreCount":4,
        "ThreadsPerCore":2
    }
}
```
All `TagSpecifications` must follow the [Kevel Infrastructure Tagging](https://docs.google.com/document/d/1yE04MCd5Wv9M4lLSTIY-BMwSeFYyXsrM2tw_1jPuGjU) rules.

All instances MUST have the following tags specified (no missing or blank values):
 * `env` - [prod | preprod | staging | dev]
 * `service` - devbox
 * `version` - [a gitsha]
 * `customer-data` - [false | true]
 * `team` - [a short string for team identifier]

The following defaults will be used if tags are missing (set within the `devbox` configuration file):
 * `env` - dev
 * `service` - devbox
 * `version` - 0000000
 * `customer-data` - false
 * `team` - engineering

The default ImageId is `resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id` (set within the `devbox` configuration file).

The default IamInstanceProfile is `AmazonSSMRoleForInstancesQuickSetup` (set within the `devbox` configuration file).

When an instance is successfully created with the `devbox init` command,
The instance ID and alias are added to the list of available devboxes (the `devbox-list`) within the `devbox` configuration file.

#### The `devbox add` command

The `devbox add` command adds an existing EC2 instance to you list of available devboxes (stored within the `devbox` configuration file).

The `devbox add` command take two arguments: an instance Id and a String alias

When the command is successful (exit code 0), it returns the instance Id.
Any non-zero exit code means the command failed and a reason or error code is returned.

#### The `devbox switch` command

The `devbox` utility tracks your `current` devbox within the `devbox` configuration file.

The `devbox switch` command sets your `current` devbox.
The command takes a single String argument, the devbox alias to switch to.

When the command is successful (exit code 0), it returns the new `current` alias.
Any non-zero exit code means the command failed and a reason or error code is returned.

#### The `devbox up` command

The `devbox up` command turns on the `current` instance, ensuring it is in the "Running" state.
When the command is successful (exit code 0), the instance ID is returned.
Any non-zero exit code means the command failed and a reason or error code is returned.

The command first queries AWS for the instance status.
If the instance is already running, no further action is taken and the instance ID is returned.
If the instance is stopped, it is activated again such that it is in the "Running" state and the instance ID is returned.
All other states are considered a failure condition and the instance ID and instance state are returned as part of the error message.

#### The `devbox down` command

The `devbox down` command turns off the `current` instance, ensuring it is in the "Stopped" state.
When the command is successful (exit code 0), the instance ID is returned.
Any non-zero exit code means the command failed and a reason or error code is returned.

The command first queries AWS for the instance status.
If the instance is already stopped, no further action is taken and the instance ID is returned.
If the instance is running, it is stopped such that it is in the "Stopped" state and the instance ID is returned.
All other states are considered a failure condition and the instance ID and instance state are returned as part of the error message.

#### The `devbox connect` command

The `devbox connect` command uses AWS SSM to connect to the machine, in the same fashion that [ssh-over-ssm](https://github.com/elpy1/ssh-over-ssm/tree/master) works.

#### The `devbox cp` command

The `devbox cp` command copies a local file to a remote path using SSM (over scp, using the same `ssh-over-ssm` technology as `devbox connect`)

#### Configuration

The `devbox` utility reads a config file at `~/.config/devbox.json` if it exists.
The config specifies defaults to use for different `devbox` commands.

The config contains a single JSON Object, with the following top-level keys:
```json
{
  "boxes": {"DevboxAlias": "InstanceId", },
  "defaults": { ... },
}
```

## Raw notes

A direct EC2 command with similar options
```
$ aws ec2 run-instances --region us-east-1 --instance-type t3.micro \
        --image-id resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
        --iam-instance-profile Name=AmazonSSMRoleForInstancesQuickSetup \
        --security-group-ids "sg-0e110355c54b34b31" \
        --no-associate-public-ip-address \
        --subnet-id subnet-07491a246e265656b \
        --user-data $'#!/bin/bash\napt-get update && apt-get install -y docker.io jq' \
        --query 'Instances[0].InstanceId' --output text

i-093e7348ef5cb9159
```
