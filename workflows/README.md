# How does workflows work?

## Building phase

- A special docker compose file is used to build the images.
- Converts the `compose-deploy.yml` files to `docker build` commands.
- Builds the images and tags them with the name of the image specified in compose file and GitHub / GitLab tag. E.g. `my-app:1.0.0`.
- Upload images as artifacts to the GitHub / GitLab job.

## Deploying phase

- The images are downloaded from the artifacts.
- Runs ansible playbooks to deploy the images on the server.