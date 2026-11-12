FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /probe .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /probe /probe
# Optional: bake or mount iptoasn.com's ip2asn-v4.tsv and set IP2ASN_TSV.
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/probe"]
